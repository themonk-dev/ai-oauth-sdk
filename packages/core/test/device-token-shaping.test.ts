import { describe, expect, it } from 'vitest'

import { defineProvider } from '../src/providers/define.js'
import { pollDeviceToken } from '../src/receivers/device.js'
import { exchangeCode } from '../src/token.js'
import type { DeviceCodeResponse, ProviderConfig } from '../src/types.js'

/*
 * The device grant used to shape its own `TokenSet` inline, so the two provider
 * hooks the redirect path runs — `parseTokenResponse` then `enrichTokens` —
 * never ran on a device login. No bundled provider declares `parseTokenResponse`
 * *and* a device endpoint, so reaching the worst of it takes a custom
 * descriptor; `xai` reaches the milder half with `enrichTokens` alone.
 */

const device: DeviceCodeResponse = {
  deviceCode: 'device-code-1',
  userCode: 'WXYZ-1234',
  verificationUri: 'https://example.test/device',
  expiresAt: Date.now() + 60_000,
  intervalMs: 1,
}

/** Answers every request with one body, so the test is only about the shaping. */
const answering = (body: unknown, status = 200) =>
  async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

const custom = (overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'shaping-test',
    label: 'Shaping Test',
    clientId: 'shaping-client',
    authorizationUrl: 'https://shaping.invalid/authorize',
    tokenUrl: 'https://shaping.invalid/token',
    deviceAuthorizationUrl: 'https://shaping.invalid/device/code',
    scopes: ['openid'],
    redirect: { mode: 'custom' },
    ...overrides,
  })

/** A non-standard 200 body: the credential is not under `access_token`. */
const NON_STANDARD_SUCCESS = {
  api_key: 'ak_live_7f3c9d02b18e4a55b6e1c4907ad3f218',
  label: 'acme cli',
  user_id: 42,
}

const keyProvider = custom({
  parseTokenResponse(raw) {
    const key = raw['api_key']

    if (typeof key !== 'string') {
      return raw
    }

    return { ...raw, access_token: key, token_type: 'Bearer' }
  },
})

describe('device grant token shaping', () => {
  it('runs parseTokenResponse on a device success, as the redirect path does', async () => {
    const fetchImpl = answering(NON_STANDARD_SUCCESS)
    const tokens = await pollDeviceToken({
      provider: keyProvider,
      clientId: 'shaping-client',
      device,
      fetchImpl,
    })

    expect(tokens.accessToken).toBe(NON_STANDARD_SUCCESS.api_key)
    expect(tokens.tokenType).toBe('Bearer')
    expect(tokens.provider).toBe('shaping-test')

    // The same body through the redirect path, which always shaped it: the
    // device grant was rejecting a response the code exchange accepted.
    const viaRedirect = await exchangeCode({
      provider: keyProvider,
      clientId: 'shaping-client',
      code: 'the-code',
      redirectUri: 'https://shaping.invalid/cb',
      fetchImpl,
    })
    expect(tokens.accessToken).toBe(viaRedirect.accessToken)
  })

  it('never quotes a 200 body it could not shape into a token', async () => {
    // Same body, no `parseTokenResponse`: nothing can be made of it, and it is
    // still a *successful* token response — so it may be the credential itself.
    // The old code reported `unknown_error` and printed a snippet of it, which
    // `redact.ts` cannot help with: an unrecognised secret under an
    // unrecognised key matches neither a known parameter name nor a known
    // token shape.
    const error = await pollDeviceToken({
      provider: custom(),
      clientId: 'shaping-client',
      device,
      fetchImpl: answering(NON_STANDARD_SUCCESS),
    }).catch((caught: Error) => caught)

    expect((error as Error).message).not.toContain('ak_live_')
    expect((error as Error).message).not.toContain('api_key')
    expect(error).toMatchObject({ code: 'invalid_token_response', status: 200 })
  })

  it('still reports an error a 200 body names, without the body around it', async () => {
    // Some providers answer a failed grant with HTTP 200 and an `error` field.
    // That stays a `device_flow_failed` carrying `providerError`; only the raw
    // body goes unquoted.
    const error = await pollDeviceToken({
      provider: custom(),
      clientId: 'shaping-client',
      device,
      fetchImpl: answering({
        error: 'access_denied',
        error_description: 'The user declined.',
        api_key: 'ak_live_7f3c9d02b18e4a55b6e1c4907ad3f218',
      }),
    }).catch((caught: Error) => caught)

    expect(error).toMatchObject({ code: 'device_flow_failed', providerError: 'access_denied' })
    expect((error as Error).message).toContain('The user declined.')
    expect((error as Error).message).not.toContain('ak_live_')
  })

  it('keeps quoting a failure body when the status says failure', async () => {
    const error = await pollDeviceToken({
      provider: custom(),
      clientId: 'shaping-client',
      device,
      fetchImpl: answering('<html>gateway is unhappy</html>', 400),
    }).catch((caught: Error) => caught)

    expect((error as Error).message).toContain('gateway is unhappy')
  })

  it('enriches a device login the same way as a redirect login', async () => {
    // `xai` declares both a device endpoint and `enrichTokens`, so a device
    // login stored a TokenSet with no accountId/email while the same account
    // via `login` got both — and they appeared on the first refresh, which does
    // enrich. Cosmetic, same root cause.
    const enriching = custom({
      enrichTokens: (raw) => ({
        accountId: String(raw['user_id'] ?? ''),
        email: String(raw['user_email'] ?? ''),
      }),
    })
    const fetchImpl = answering({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'openid',
      user_id: 'acct-42',
      user_email: 'someone@example.test',
    })

    const viaDevice = await pollDeviceToken({
      provider: enriching,
      clientId: 'shaping-client',
      device,
      fetchImpl,
    })
    const viaRedirect = await exchangeCode({
      provider: enriching,
      clientId: 'shaping-client',
      code: 'the-code',
      redirectUri: 'https://shaping.invalid/cb',
      fetchImpl,
    })

    expect(viaDevice.accountId).toBe('acct-42')
    expect(viaDevice.email).toBe('someone@example.test')
    expect(viaDevice.accountId).toBe(viaRedirect.accountId)
    expect(viaDevice.email).toBe(viaRedirect.email)
    expect(viaDevice.refreshToken).toBe('refresh-1')
    expect(viaDevice.scope).toBe('openid')
    expect(viaDevice.expiresAt).toBeGreaterThan(Date.now())
  })
})
