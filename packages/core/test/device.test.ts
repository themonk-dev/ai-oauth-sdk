import { afterEach, describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { defineProvider } from '../src/providers/define.js'
import { pollDeviceToken, startDeviceAuthorization } from '../src/receivers/device.js'
import { memoryStorage } from '../src/storage.js'
import type { ProviderConfig } from '../src/types.js'
import { startFakeAuthServer, type FakeAuthServer } from './helpers/fakeAuthServer.js'

const servers: FakeAuthServer[] = []

async function server(options: Parameters<typeof startFakeAuthServer>[0] = {}) {
  const instance = await startFakeAuthServer(options)
  servers.push(instance)

  return instance
}

const deviceProvider = (url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'device-test',
    label: 'Device Test',
    clientId: 'device-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    deviceAuthorizationUrl: `${url}/device/code`,
    scopes: ['openid'],
    redirect: { mode: 'custom' },
    ...overrides,
  })

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('device authorization flow', () => {
  it('returns the code the user has to type', async () => {
    const target = await server({ device: {} })
    const device = await startDeviceAuthorization({
      provider: deviceProvider(target.url),
      clientId: 'device-client',
    })

    expect(device.userCode).toBe('WXYZ-1234')
    expect(device.verificationUri).toBe('https://example.test/device')
    expect(device.verificationUriComplete).toContain('WXYZ-1234')
    expect(device.expiresAt).toBeGreaterThan(Date.now())
  })

  it('polls until the user approves', async () => {
    const target = await server({ device: { pendingPolls: 2 } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    const tokens = await pollDeviceToken({ provider, clientId: 'device-client', device })

    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('device-refresh-1')
    // Two pending answers, then the grant.
    expect(target.devicePolls).toBe(3)
  })

  it('backs off on slow_down instead of hammering', async () => {
    const target = await server({ device: { slowDownOnce: true } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    const started = Date.now()
    const tokens = await pollDeviceToken({ provider, clientId: 'device-client', device })

    expect(tokens.accessToken).toBeTruthy()
    // The RFC requires adding 5s to the interval on slow_down.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
  }, 20_000)

  it('surfaces a terminal error', async () => {
    const target = await server({ device: { failWith: 'access_denied' } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    await expect(
      pollDeviceToken({ provider, clientId: 'device-client', device }),
    ).rejects.toMatchObject({ code: 'device_flow_failed', providerError: 'access_denied' })
  })

  it('stops when the device code expires', async () => {
    const target = await server({ device: { pendingPolls: 1000, expiresIn: 1 } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    await expect(
      pollDeviceToken({ provider, clientId: 'device-client', device }),
    ).rejects.toMatchObject({ code: 'timeout' })
  }, 20_000)

  it('honours an abort signal mid-poll', async () => {
    const target = await server({ device: { pendingPolls: 1000, interval: 2 } })
    const provider = deviceProvider(target.url)
    const controller = new AbortController()

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    const polling = pollDeviceToken({
      provider,
      clientId: 'device-client',
      device,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)

    await expect(polling).rejects.toMatchObject({ code: 'aborted' })
  })

  it('drives the whole flow through client.deviceLogin()', async () => {
    const target = await server({ device: { pendingPolls: 1 } })
    const client = createAuthClient({
      provider: deviceProvider(target.url),
      storage: memoryStorage(),
    })

    let shown: { userCode: string; verificationUri: string } | undefined
    const tokens = await client.deviceLogin({
      onCode: (device) => {
        shown = { userCode: device.userCode, verificationUri: device.verificationUri }
      },
    })

    expect(shown?.userCode).toBe('WXYZ-1234')
    expect(tokens.accessToken).toBe('access-1')
    // Tokens are persisted just like the redirect flow.
    expect(await client.isAuthenticated()).toBe(true)
  })

  // RFC 8628 does not mention PKCE, so the device request used to omit it and
  // Qwen answered every login with a bare "HTTP 400".
  it('binds the device request with PKCE and redeems it with the verifier', async () => {
    const target = await server({ device: { requirePkce: true } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    expect(target.deviceRequests[0]?.['code_challenge']).toBeTruthy()
    expect(target.deviceRequests[0]?.['code_challenge_method']).toBe('S256')
    expect(device.codeVerifier).toBeTruthy()

    const tokens = await pollDeviceToken({ provider, clientId: 'device-client', device })
    expect(tokens.accessToken).toBe('access-1')
    expect(target.requests.at(-1)?.['code_verifier']).toBe(device.codeVerifier)
  })

  it('omits PKCE for a provider that does not use it', async () => {
    const target = await server({ device: {} })
    const provider = deviceProvider(target.url, { usePkce: false })

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    expect(target.deviceRequests[0]?.['code_challenge']).toBeUndefined()
    expect(device.codeVerifier).toBeUndefined()

    await pollDeviceToken({ provider, clientId: 'device-client', device })
    expect(target.requests.at(-1)?.['code_verifier']).toBeUndefined()
  })

  it("quotes the provider's complaint instead of just the status", async () => {
    const target = await server({ device: { requirePkce: true } })
    const provider = deviceProvider(target.url, { usePkce: false })

    await expect(
      startDeviceAuthorization({ provider, clientId: 'device-client' }),
    ).rejects.toThrowError(/code_challenge is required for PKCE/)
  })

  it('keeps polling through a gateway 5xx rather than abandoning the code', async () => {
    // An HTML error page from a proxy is not a verdict on the grant, and the
    // user may already have approved it — parsing it to `{}` and reporting
    // `unknown_error` threw away a live login.
    const target = await server({ device: { gatewayErrorOnce: true } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    const tokens = await pollDeviceToken({ provider, clientId: 'device-client', device })

    expect(tokens.accessToken).toBeTruthy()
    expect(target.devicePolls).toBe(2)
  }, 20_000)

  /*
   * Tolerating a 5xx forever meant a proxy that was simply down blocked for the
   * whole ~15-minute code lifetime and then reported a timeout, telling the
   * user they were too slow to approve when the truth was a 502 all along.
   */
  it('gives up on a gateway that never recovers, and says what happened', async () => {
    const target = await server({ device: { gatewayErrorAlways: true, interval: 0 } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    const error = await pollDeviceToken({ provider, clientId: 'device-client', device }).catch(
      (caught: Error) => caught,
    )

    expect(error).toMatchObject({ code: 'device_flow_failed', status: 504 })
    expect((error as Error).message).not.toContain('expired')
    expect(target.devicePolls).toBeLessThanOrEqual(5)
  }, 20_000)

  /*
   * `error_description` and the raw body were already scrubbed; `error` was
   * interpolated verbatim, so a gateway reflecting the poll body printed the
   * device code and the PKCE verifier into the message and onto `providerError`.
   */
  it('redacts a credential reflected back in the error code', async () => {
    // No server: the point is the body, so the poll is answered directly.
    const provider = deviceProvider('https://device.invalid')
    const reflected =
      'invalid_grant: could not process grant_type=urn:ietf:params:oauth:grant-type:device_code ' +
      'device_code=DEV-SECRET-0123456789abcdef code_verifier=VERIFIER-0123456789abcdef'

    const error = await pollDeviceToken({
      provider,
      clientId: 'device-client',
      device: {
        deviceCode: 'DEV-SECRET-0123456789abcdef',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://example.test/device',
        expiresAt: Date.now() + 60_000,
        intervalMs: 1,
        codeVerifier: 'VERIFIER-0123456789abcdef',
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: reflected }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    }).catch((caught: Error) => caught)

    expect((error as Error).message).not.toContain('DEV-SECRET')
    expect((error as Error).message).not.toContain('VERIFIER-')
    expect((error as Error).message).toContain('device_code=[redacted]')
    expect(error).toMatchObject({ code: 'device_flow_failed' })
    expect((error as { providerError?: string }).providerError).not.toContain('DEV-SECRET')
  })

  // Short spec codes are unchanged by redaction, so `providerError` still
  // carries exactly what the provider said. See the `access_denied` case above.
  it('leaves a spec error code intact', async () => {
    const target = await server({ device: { failWith: 'expired_token' } })
    const provider = deviceProvider(target.url)

    const device = await startDeviceAuthorization({ provider, clientId: 'device-client' })
    await expect(
      pollDeviceToken({ provider, clientId: 'device-client', device }),
    ).rejects.toMatchObject({ providerError: 'expired_token' })
  })

  it('explains when a provider has no device endpoint', async () => {
    const target = await server()
    const client = createAuthClient({
      provider: deviceProvider(target.url, { deviceAuthorizationUrl: undefined }),
      storage: memoryStorage(),
    })
    await expect(client.deviceLogin({ onCode: () => {} })).rejects.toMatchObject({
      code: 'configuration_error',
    })
  })
})
