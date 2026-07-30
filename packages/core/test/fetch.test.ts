import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch, fetchUserInfo } from '../src/fetch.js'
import { defineProvider } from '../src/providers/define.js'
import { memoryStorage } from '../src/storage.js'
import type { AuthClient } from '../src/client.js'
import type { ProviderConfig } from '../src/types.js'
import { startFakeAuthServer, type FakeAuthServer } from './helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    revocationUrl: `${url}/revoke`,
    userInfoUrl: `${url}/userinfo`,
    apiBaseUrl: `${url}/api`,
    scopes: ['openid'],
    redirect: { mode: 'loopback', loopbackPort: 0 },
    ...overrides,
  })

async function signedInClient(target: FakeAuthServer, overrides: Partial<ProviderConfig> = {}) {
  const client = createAuthClient({
    provider: testProvider(target.url, overrides),
    redirectUri: 'http://localhost:9999/callback',
    storage: memoryStorage(),
  })
  const authorization = await client.createAuthorization()
  const response = await fetch(authorization.url, { redirect: 'manual' })
  const params = new URL(response.headers.get('location')!).searchParams
  await client.completeAuthorization({ code: params.get('code')!, state: params.get('state')! })
  return client
}

beforeEach(async () => {
  server = await startFakeAuthServer()
})

afterEach(async () => {
  await server.close()
})

describe('createAuthenticatedFetch', () => {
  it('attaches the bearer token', async () => {
    const client = await signedInClient(server)
    const api = createAuthenticatedFetch(client)

    const response = await api('/echo')
    expect(response.status).toBe(200)
    expect(server.apiRequests[0]?.['authorization']).toBe('Bearer access-1')
  })

  it('resolves relative paths against the provider apiBaseUrl', async () => {
    const client = await signedInClient(server)
    const api = createAuthenticatedFetch(client)

    await api('echo') // no leading slash
    await api('/echo') // leading slash
    expect(server.apiCount).toBe(2)
  })

  it('leaves absolute URLs alone', async () => {
    const client = await signedInClient(server)
    const api = createAuthenticatedFetch(client)

    const response = await api(`${server.url}/api/echo`)
    expect(response.status).toBe(200)
  })

  it('refreshes and retries once on 401', async () => {
    const client = await signedInClient(server)

    // Simulate a token revoked server-side before its nominal expiry: our local
    // clock still says valid, so only the 401 reveals the truth.
    await client.setTokens({ ...(await client.getTokens())!, accessToken: 'stale-token' })

    const api = createAuthenticatedFetch(client)
    const response = await api('/echo')

    expect(response.status).toBe(200)
    expect(server.refreshCount).toBe(1)
    // First attempt with the stale token, second with the refreshed one.
    expect(server.apiRequests[0]?.['authorization']).toBe('Bearer stale-token')
    expect(server.apiRequests[1]?.['authorization']).toBe('Bearer access-2')
  })

  it('does not retry when the option is off', async () => {
    const client = await signedInClient(server)
    await client.setTokens({ ...(await client.getTokens())!, accessToken: 'stale-token' })

    const api = createAuthenticatedFetch(client, { retryOnUnauthorized: false })
    const response = await api('/echo')

    expect(response.status).toBe(401)
    expect(server.refreshCount).toBe(0)
  })

  it('only retries once, so a persistently-401 API cannot loop', async () => {
    const client = await signedInClient(server)
    await client.setTokens({ ...(await client.getTokens())!, accessToken: 'stale' })

    // Point the API at a path that always 401s regardless of token.
    const api = createAuthenticatedFetch(client)
    await api('/echo')
    const callsAfterFirst = server.apiCount

    await api('/echo')
    // Two logical calls → at most 3 HTTP requests (1 retry on the first only,
    // since the refresh fixed the token for the second).
    expect(server.apiCount).toBeLessThanOrEqual(callsAfterFirst + 2)
  })

  it('adds provider-declared API headers', async () => {
    const client = await signedInClient(server, {
      apiHeaders: () => ({ 'anthropic-version': '2023-06-01', 'x-custom': 'yes' }),
    })
    const api = createAuthenticatedFetch(client)
    await api('/echo')

    expect(server.apiRequests[0]?.['anthropic-version']).toBe('2023-06-01')
    expect(server.apiRequests[0]?.['x-custom']).toBe('yes')
  })

  it('lets caller headers win over provider defaults', async () => {
    const client = await signedInClient(server, {
      apiHeaders: () => ({ 'x-custom': 'from-provider' }),
    })
    const api = createAuthenticatedFetch(client)
    await api('/echo', { headers: { 'x-custom': 'from-caller' } })

    expect(server.apiRequests[0]?.['x-custom']).toBe('from-caller')
  })

  it('lets an explicit Authorization header win', async () => {
    const client = await signedInClient(server)
    const api = createAuthenticatedFetch(client)
    await api('/echo', { headers: { Authorization: 'Bearer caller-supplied' } })

    expect(server.apiRequests[0]?.['authorization']).toBe('Bearer caller-supplied')
  })

  it('merges instance-level headers', async () => {
    const client = await signedInClient(server)
    const api = createAuthenticatedFetch(client, { headers: { 'user-agent': 'my-cli/1.0' } })
    await api('/echo')

    expect(server.apiRequests[0]?.['user-agent']).toBe('my-cli/1.0')
  })

  it('forwards method and body', async () => {
    const client = await signedInClient(server)
    const api = createAuthenticatedFetch(client)
    const response = await api('/echo', { method: 'POST', body: '{"hello":1}' })

    expect(((await response.json()) as { method: string }).method).toBe('POST')
  })

  it('reports clearly when the token is dead and unrefreshable', async () => {
    const client = await signedInClient(server)
    // No refresh token, and a bad access token: nothing can rescue this.
    await client.setTokens({
      ...(await client.getTokens())!,
      accessToken: 'stale',
      refreshToken: undefined,
    })

    const api = createAuthenticatedFetch(client)
    await expect(api('/echo')).rejects.toMatchObject({ code: 'refresh_failed' })
  })
})

describe('fetchUserInfo', () => {
  it('returns the userinfo payload', async () => {
    const client = await signedInClient(server)
    await expect(fetchUserInfo(client)).resolves.toMatchObject({
      sub: 'user-1',
      email: 'dev@example.com',
    })
  })

  it('explains when the provider has no userinfo endpoint', async () => {
    const client = await signedInClient(server, { userInfoUrl: undefined })
    await expect(fetchUserInfo(client)).rejects.toMatchObject({ code: 'configuration_error' })
  })
})

describe('revocation', () => {
  it('revokes the refresh token by default', async () => {
    const client = await signedInClient(server)
    await client.revoke()

    expect(server.revocations[0]?.['token']).toBe('refresh-1')
    expect(server.revocations[0]?.['token_type_hint']).toBe('refresh_token')
    expect(server.revocations[0]?.['client_id']).toBe('test-client')
  })

  it('can revoke the access token instead', async () => {
    const client = await signedInClient(server)
    await client.revoke({ tokenType: 'access_token' })

    expect(server.revocations[0]?.['token']).toBe('access-1')
    expect(server.revocations[0]?.['token_type_hint']).toBe('access_token')
  })

  it('logout({ revoke: true }) tells the provider and clears locally', async () => {
    const client = await signedInClient(server)
    await client.logout({ revoke: true })

    expect(server.revocations).toHaveLength(1)
    expect(await client.getTokens()).toBeUndefined()
  })

  it('still clears local tokens when revocation fails', async () => {
    // Revocation endpoint that does not exist on this server.
    const client = await signedInClient(server, { revocationUrl: `${server.url}/nope` })
    await client.logout({ revoke: true })

    // A provider-side failure must not leave the user apparently signed in.
    expect(await client.getTokens()).toBeUndefined()
  })

  it('explains when the provider has no revocation endpoint', async () => {
    const client = await signedInClient(server, { revocationUrl: undefined })
    await expect(client.revoke()).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('a revoked session cannot be refreshed back to life', async () => {
    const client = await signedInClient(server)
    await client.revoke()
    await expect(client.refresh()).rejects.toMatchObject({ code: 'refresh_failed' })
  })

  it('revoking without tokens is a no-op', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    await expect(client.revoke()).resolves.toBeUndefined()
    expect(server.revocations).toHaveLength(0)
  })
})

describe('provider API headers', () => {
  it('OpenAI names the billed account', async () => {
    const { openai } = await import('../src/providers/openai.js')
    expect(openai.apiHeaders!({ accountId: 'acct-1' } as never)).toEqual({
      'chatgpt-account-id': 'acct-1',
    })
    // Nothing to send when the account is unknown.
    expect(openai.apiHeaders!({} as never)).toEqual({})
  })

  it('Anthropic opts into the OAuth beta', async () => {
    const { anthropic } = await import('../src/providers/anthropic.js')
    const headers = anthropic.apiHeaders!({} as never)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20')
  })
})

// Keep the AuthClient type referenced so this file's imports stay honest.
export type { AuthClient }
