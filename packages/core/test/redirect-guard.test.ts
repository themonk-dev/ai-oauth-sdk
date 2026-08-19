import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { defineProvider } from '../src/providers/define.js'
import { providers } from '../src/providers/index.js'
import { pollDeviceToken, startDeviceAuthorization } from '../src/receivers/device.js'
import { openaiDeviceFlow } from '../src/receivers/openai-device.js'
import { revokeToken } from '../src/revoke.js'
import { exchangeCode, refreshTokens } from '../src/token.js'
import type { DeviceCodeResponse, ProviderConfig, TokenSet } from '../src/types.js'

/**
 * Every credential this library holds travels in a POST body, and `fetch`
 * follows redirects by default. Under undici a 307 or 308 preserves the method
 * and replays that body verbatim to the origin the `Location` names — so a
 * single hop hands the refresh token, the authorization code, the PKCE verifier
 * and the client secret to whoever answers. The header-stripping undici does do
 * cross-origin is no help, because none of this lives in a header.
 *
 * A 301/302/303 is rewritten to a bodiless GET and leaks nothing, but is still
 * followed silently, and the target's response is then read as the token
 * endpoint's — a forged `access_token` accepted and stored.
 *
 * The `sinkHits` assertion is the load-bearing one. That the call rejects only
 * says something went wrong; that the sink was never reached says the request
 * was refused rather than sent and then disliked, and it is what would catch a
 * regression to `redirect: 'manual'`.
 */
interface SinkHit {
  method: string
  body: string
}

let sink: Server
let redirector: Server
let redirectorUrl: string
let sinkHits: SinkHit[] = []
/** The hop the redirector answers with; a case may lower it to 302. */
let redirectStatus = 308

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })

beforeAll(async () => {
  sink = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      sinkHits.push({ method: request.method ?? '', body })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ access_token: 'pwned', token_type: 'Bearer' }))
    })
  })
  const sinkPort = await listen(sink)

  redirector = createServer((request, response) => {
    /* Drain, so the hop is answered rather than the socket stalled. */
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(redirectStatus, {
        Location: `http://127.0.0.1:${sinkPort}/steal`,
      })
      response.end()
    })
  })
  redirectorUrl = `http://127.0.0.1:${await listen(redirector)}`
})

afterAll(async () => {
  await Promise.all([close(sink), close(redirector)])
})

beforeEach(() => {
  sinkHits = []
  redirectStatus = 308
})

const provider = (): ProviderConfig =>
  defineProvider({
    id: 'redirecting',
    label: 'Redirecting',
    clientId: 'redirect-client',
    authorizationUrl: `${redirectorUrl}/authorize`,
    tokenUrl: `${redirectorUrl}/token`,
    revocationUrl: `${redirectorUrl}/revoke`,
    deviceAuthorizationUrl: `${redirectorUrl}/device/code`,
    scopes: ['openid'],
    redirect: { mode: 'custom' },
  })

const tokens = (): TokenSet => ({
  accessToken: 'at-1',
  refreshToken: 'SUPER-SECRET-REFRESH',
  tokenType: 'Bearer',
  provider: 'redirecting',
  raw: {},
})

const device = (): DeviceCodeResponse => ({
  deviceCode: 'SUPER-SECRET-DEVICE-CODE',
  userCode: 'WXYZ-1234',
  verificationUri: 'https://example.test/device',
  expiresAt: Date.now() + 30_000,
  intervalMs: 1,
  codeVerifier: 'SUPER-SECRET-VERIFIER',
})

describe('credential-bearing POSTs refuse to follow a redirect', () => {
  it('does not replay the refresh token to the redirect target', async () => {
    await expect(
      refreshTokens({ provider: provider(), clientId: 'redirect-client', tokens: tokens() }),
    ).rejects.toThrow()

    expect(sinkHits).toEqual([])
  })

  it('does not replay the code and PKCE verifier to the redirect target', async () => {
    await expect(
      exchangeCode({
        provider: provider(),
        clientId: 'redirect-client',
        code: 'SUPER-SECRET-CODE',
        redirectUri: 'http://localhost/cb',
        codeVerifier: 'SUPER-SECRET-VERIFIER',
      }),
    ).rejects.toThrow()

    expect(sinkHits).toEqual([])
  })

  it('does not replay the revoked token to the redirect target', async () => {
    await expect(
      revokeToken({ provider: provider(), clientId: 'redirect-client', tokens: tokens() }),
    ).rejects.toThrow()

    expect(sinkHits).toEqual([])
  })

  it('does not replay the device authorization request', async () => {
    await expect(
      startDeviceAuthorization({ provider: provider(), clientId: 'redirect-client' }),
    ).rejects.toThrow()

    expect(sinkHits).toEqual([])
  })

  it('does not replay the device code from the poll loop', async () => {
    await expect(
      pollDeviceToken({ provider: provider(), clientId: 'redirect-client', device: device() }),
    ).rejects.toThrow()

    expect(sinkHits).toEqual([])
  })

  /*
   * A 302 is rewritten to a GET, so no credential goes anywhere — but following
   * it would take the target's body as the token response. Rejecting is the
   * only correct outcome; resolving with `pwned` is the bug.
   */
  it('refuses a 302 too, which injects a token rather than leaking one', async () => {
    redirectStatus = 302

    const result = await refreshTokens({
      provider: provider(),
      clientId: 'redirect-client',
      tokens: tokens(),
    }).catch((error: unknown) => error)

    expect(result).toBeInstanceOf(Error)
    expect(result).not.toMatchObject({ accessToken: 'pwned' })
    expect(sinkHits).toEqual([])
  })

  /*
   * OpenAI's device flow posts to hardcoded `auth.openai.com` URLs, so there is
   * no provider config to point at the redirector above. The guard is asserted
   * on the request instead: whatever `fetch` this flow is handed must be asked
   * to refuse the hop. Both of its endpoints go through one helper, so the
   * start call covers the poll too.
   */
  it('asks its fetch to refuse a redirect on the OpenAI device endpoints', async () => {
    const seen: (RequestInit | undefined)[] = []
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      seen.push(init)

      return Promise.resolve(
        new Response(
          JSON.stringify({ device_auth_id: 'd-1', user_code: 'WXYZ-1234', interval: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }

    await openaiDeviceFlow.start({
      provider: providers.openai,
      clientId: 'redirect-client',
      fetchImpl,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', redirect: 'error' })
  })
})
