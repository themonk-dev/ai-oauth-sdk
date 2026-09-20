/**
 * Credential-bearing POSTs must not follow a redirect.
 *
 * `fetch` defaults to `redirect: 'follow'`, and a 307 or 308 preserves the
 * method and the body when it is followed — so a token endpoint answering
 * `Location: http://attacker.example/…` gets the refresh token, the PKCE
 * verifier and the client secret replayed at it, and its reply comes back to be
 * parsed as the token response. Every test here runs against a real server on
 * loopback rather than a stub, so what is being asserted is the runtime's
 * actual redirect behaviour and not a mock's.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import { defineProvider } from '../src/providers/define.js'
import { openaiDeviceFlow } from '../src/receivers/openai-device.js'
import { pollDeviceToken, startDeviceAuthorization } from '../src/receivers/device.js'
import { memoryStorage } from '../src/storage.js'
import { revokeToken } from '../src/revoke.js'
import { exchangeCode, refreshTokens } from '../src/token.js'
import type { CallbackReceiver, FetchLike, ProviderConfig, TokenSet } from '../src/types.js'
import { startFakeAuthServer, type FakeAuthServer } from './helpers/fakeAuthServer.js'

const servers: FakeAuthServer[] = []
const plainServers: Server[] = []

async function authServer(options: Parameters<typeof startFakeAuthServer>[0] = {}) {
  const instance = await startFakeAuthServer(options)
  servers.push(instance)

  return instance
}

interface Attacker {
  url: string
  /** Every request that reached it: method, path and raw body. */
  received: Array<{ method: string; path: string; body: string }>
}

/**
 * The host a redirect points at. It answers with a perfectly good token
 * response, which is the point: if anything ever reaches it, the flow succeeds
 * with *its* access token and nothing looks wrong from the outside.
 */
async function startAttacker(): Promise<Attacker> {
  const received: Array<{ method: string; path: string; body: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      received.push({ method: request.method ?? '', path: request.url ?? '', body })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          access_token: 'attacker-access-token',
          refresh_token: 'attacker-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          device_code: 'attacker-device-code',
          user_code: 'ATTACKER',
          verification_uri: 'https://attacker.example/device',
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  plainServers.push(server)

  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received }
}

const testProvider = (url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'redirecting',
    label: 'Redirecting',
    clientId: 'test-client',
    clientSecret: 'super-secret',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    revocationUrl: `${url}/revoke`,
    deviceAuthorizationUrl: `${url}/device/code`,
    scopes: ['openid'],
    redirect: { mode: 'loopback', loopbackPort: 0 },
    ...overrides,
  })

/** Drives the fake authorization endpoint and hands back the real callback. */
const scriptedReceiver = (): CallbackReceiver => ({
  id: 'scripted',
  async start() {
    let result: Promise<{ code: string; state: string }> | undefined

    return {
      redirectUri: 'http://localhost:9999/callback',
      async present(url) {
        result = fetch(url, { redirect: 'manual' }).then((response) => {
          const params = new URL(response.headers.get('location')!).searchParams

          return { code: params.get('code')!, state: params.get('state')! }
        })
      },
      wait: () => result!,
      async close() {},
    }
  },
})

const storedTokens = (): TokenSet => ({
  accessToken: 'AT',
  refreshToken: 'rt-super-secret-do-not-replay',
  tokenType: 'Bearer',
  provider: 'redirecting',
  raw: {},
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((instance) => instance.close()))
  await Promise.all(
    plainServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections?.()
        }),
    ),
  )
})

describe('the token endpoint is not allowed to redirect the exchange', () => {
  it('refuses a 307 instead of replaying the code and verifier at the new host', async () => {
    const attacker = await startAttacker()
    const target = await authServer({ redirectPostsTo: { location: `${attacker.url}/token` } })
    const client = createAuthClient({
      provider: testProvider(target.url),
      storage: memoryStorage(),
    })

    const error = await client.login({ receiver: scriptedReceiver() }).catch((caught: Error) => caught)

    expect(error).toMatchObject({
      name: 'OAuthError',
      code: 'token_request_failed',
      status: 307,
    })
    expect((error as Error).message).toMatch(/redirect/)
    // The provider is named, so the failure is diagnosable — the whole reason
    // this is `redirect: 'manual'` and a check rather than `redirect: 'error'`,
    // which raises a bare `TypeError: fetch failed`.
    expect((error as Error).message).toContain('redirecting')
    expect(attacker.received, 'nothing may reach the redirect target').toEqual([])
    // And no token was adopted from it either.
    expect(await client.getTokens()).toBeUndefined()
  })

  it('refuses a 308 on a refresh, so the refresh token is never replayed', async () => {
    const attacker = await startAttacker()
    const target = await authServer({
      redirectPostsTo: { location: `${attacker.url}/token`, status: 308 },
    })
    const provider = testProvider(target.url)

    const error = await refreshTokens({
      provider,
      clientId: 'test-client',
      tokens: storedTokens(),
    }).catch((caught: Error) => caught)

    expect(error).toMatchObject({ name: 'OAuthError', code: 'refresh_failed' })
    expect(attacker.received).toEqual([])
  })

  it('refuses a 302 as well, which drops the body but still hands over the response', async () => {
    // A 302 is replayed as a GET, so the credentials stay put — but the
    // attacker still gets to write the token response, and its `access_token`
    // is the one the caller would go on to use.
    const attacker = await startAttacker()
    const target = await authServer({
      redirectPostsTo: { location: `${attacker.url}/token`, status: 302 },
    })

    await expect(
      exchangeCode({
        provider: testProvider(target.url),
        clientId: 'test-client',
        code: 'code-1',
        redirectUri: 'http://localhost:9999/callback',
        codeVerifier: 'verifier-value',
      }),
    ).rejects.toMatchObject({ code: 'token_request_failed', status: 302 })
    expect(attacker.received).toEqual([])
  })

  it('sends redirect: manual, so a runtime that honours it never dials out', async () => {
    // The status check above catches the hop after the fact. This is the
    // request-side half of the fix, and the only half React Native's
    // XHR-backed `fetch` ignores.
    const seen: RequestInit[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init ?? {})

      return new Response(JSON.stringify({ access_token: 'AT', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await exchangeCode({
      provider: testProvider('http://127.0.0.1:1'),
      clientId: 'test-client',
      code: 'code-1',
      redirectUri: 'http://localhost:9999/callback',
      fetchImpl,
    })

    expect(seen[0]).toMatchObject({ redirect: 'manual' })
  })

  it('treats a browser opaqueredirect as the redirect it is', async () => {
    // Browsers and Workers answer `redirect: 'manual'` with a filtered response
    // whose status reads 0 and whose headers are stripped, so the status range
    // check alone would let it through as a non-redirect.
    // The constructor refuses status 0, so both fields are defined onto it —
    // which is exactly the shape the platform hands back.
    const opaque = new Response(null, { status: 200 })
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' })
    Object.defineProperty(opaque, 'status', { value: 0 })

    const error = await exchangeCode({
      provider: testProvider('http://127.0.0.1:1'),
      clientId: 'test-client',
      code: 'code-1',
      redirectUri: 'http://localhost:9999/callback',
      fetchImpl: async () => opaque,
    }).catch((caught: Error) => caught)

    expect(error).toMatchObject({ name: 'OAuthError', code: 'token_request_failed' })
    // Nothing to quote: an opaque redirect carries no status worth reporting.
    expect((error as { status?: number }).status).toBeUndefined()
  })

  it('leaves an ordinary 2xx alone', async () => {
    const target = await authServer()
    const client = createAuthClient({
      provider: testProvider(target.url),
      storage: memoryStorage(),
    })

    await expect(client.login({ receiver: scriptedReceiver() })).resolves.toMatchObject({
      accessToken: 'access-1',
    })
  })
})

describe('revocation is not allowed to be redirected either', () => {
  it('refuses the hop rather than posting the refresh token onward', async () => {
    const attacker = await startAttacker()
    const target = await authServer({ redirectPostsTo: { location: `${attacker.url}/revoke` } })

    await expect(
      revokeToken({
        provider: testProvider(target.url),
        clientId: 'test-client',
        tokens: storedTokens(),
      }),
    ).rejects.toMatchObject({ code: 'token_request_failed', status: 307 })
    expect(attacker.received).toEqual([])
  })
})

describe('the device flow is not allowed to be redirected', () => {
  it('refuses a redirected device authorization request', async () => {
    const attacker = await startAttacker()
    const target = await authServer({
      device: {},
      redirectPostsTo: { location: `${attacker.url}/device/code` },
    })

    const error = await startDeviceAuthorization({
      provider: testProvider(target.url),
      clientId: 'test-client',
    }).catch((caught: Error) => caught)

    // Following it would have taken the `verification_uri` — the URL the user
    // is told to open and type a code into — from the redirect target.
    expect(error).toMatchObject({ name: 'OAuthError', code: 'device_flow_failed' })
    expect(attacker.received).toEqual([])
  })

  it('refuses a redirected poll instead of continuing to poll', async () => {
    const attacker = await startAttacker()
    const target = await authServer({
      device: {},
      redirectPostsTo: { location: `${attacker.url}/token` },
    })

    const error = await pollDeviceToken({
      provider: testProvider(target.url),
      clientId: 'test-client',
      device: {
        deviceCode: 'device-code-1',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://example.test/device',
        codeVerifier: 'verifier-value',
        expiresAt: Date.now() + 60_000,
        intervalMs: 0,
      },
    }).catch((caught: Error) => caught)

    expect(error).toMatchObject({ name: 'OAuthError', code: 'device_flow_failed' })
    expect(attacker.received).toEqual([])
  })

  it('still follows a redirect on the caller’s own API requests', async () => {
    // The guard is deliberately not in `fetchWithSignal`, which
    // `createAuthenticatedFetch` shares: a redirect on an API call is ordinary
    // traffic and following it is correct. Nothing else pins that, so folding
    // the guard down a layer would otherwise break API redirects in silence.
    const destination = await startAttacker()
    const gateway = createServer((request, response) => {
      response.writeHead(302, { Location: `${destination.url}${request.url ?? '/'}` })
      response.end()
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    plainServers.push(gateway)

    const target = await authServer()
    const client = createAuthClient({
      provider: testProvider(target.url),
      storage: memoryStorage(),
    })
    await client.setTokens(storedTokens())

    const response = await createAuthenticatedFetch(client)(
      `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1/models`,
    )

    expect(response.status, 'the redirect should have been followed').toBe(200)
    expect(destination.received).toMatchObject([{ method: 'GET', path: '/v1/models' }])
  })

  it("refuses a redirect on OpenAI's device flow, which posts to fixed URLs", async () => {
    // Its endpoints are hard-coded to auth.openai.com, so the redirect is
    // injected through `fetchImpl` rather than by standing up a server.
    const seen: RequestInit[] = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {})

      return new Response(null, {
        status: 307,
        headers: { Location: 'http://attacker.example/usercode' },
      })
    }

    await expect(
      openaiDeviceFlow.start({ provider: testProvider('http://127.0.0.1:1'), clientId: 'c', fetchImpl }),
    ).rejects.toMatchObject({ name: 'OAuthError', code: 'device_flow_failed', status: 307 })
    expect(seen[0]).toMatchObject({ redirect: 'manual' })
  })
})
