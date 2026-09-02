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

/**
 * An ordinary normaliser: it returns the token fields and nothing else, which
 * is what a `parseTokenResponse` written against a success body looks like.
 * Note what it does *not* carry through — `error`.
 */
const normalising = custom({
  parseTokenResponse: (raw) => ({
    access_token: raw['access_token'],
    refresh_token: raw['refresh_token'],
    expires_in: raw['expires_in'],
    token_type: raw['token_type'],
  }),
})

/** Answers with each body in turn, and counts the polls. */
const answeringInTurn = (bodies: unknown[], status = 200) => {
  const state = { polls: 0 }
  const fetchImpl = async () => {
    const body = bodies[Math.min(state.polls++, bodies.length - 1)]

    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { fetchImpl, state }
}

const APPROVED = { access_token: 'gho_realtokenvalue0123456789', token_type: 'bearer', expires_in: 3600 }

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

  /*
   * The error code decides what the loop does next, so it has to be read off
   * the body the *server* sent. Reading it off the transform instead broke
   * every provider that answers a pending grant with HTTP 200 — GitHub's device
   * endpoint historically does — as soon as it also declared a normaliser: the
   * transform drops `error`, so poll #1 named nothing and the login failed
   * before the user could reach the verification page.
   */
  it('keeps polling a 200 authorization_pending that the transform drops', async () => {
    const { fetchImpl, state } = answeringInTurn([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      APPROVED,
    ])

    const tokens = await pollDeviceToken({
      provider: normalising,
      clientId: 'shaping-client',
      device,
      fetchImpl,
    })

    expect(tokens.accessToken).toBe(APPROVED.access_token)
    expect(state.polls).toBe(3)
  })

  it('still backs off on a 200 slow_down that the transform drops', async () => {
    const { fetchImpl, state } = answeringInTurn([{ error: 'slow_down' }, APPROVED])
    const started = Date.now()

    const tokens = await pollDeviceToken({
      provider: normalising,
      clientId: 'shaping-client',
      device: { ...device, expiresAt: Date.now() + 30_000 },
      fetchImpl,
    })

    expect(tokens.accessToken).toBe(APPROVED.access_token)
    expect(state.polls).toBe(2)
    // The RFC's 5s step, which only happens if `slow_down` was seen at all.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000)
  }, 20_000)

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

  /*
   * Suppressing the raw body is the deliberate trade — that is what keeps a
   * live credential out of the logs — but the two fields that *say* what went
   * wrong are not the body, and dropping them with it left the user staring at
   * "did not include an access_token" for a grant the provider had described
   * perfectly well. The code matters too: the CLI hangs its `devicePrerequisite`
   * hint off `device_flow_failed`, and `invalid_token_response` silently turned
   * that hint off.
   *
   * Only the flat shape survived before; the nested one (OpenAI's, which
   * `readTokenError` unwraps on the redirect path) and the form-encoded one
   * (which never parses as JSON, so the body arrives empty) were swallowed
   * whole, as was a body carrying only a description.
   */
  it.each([
    [
      'the conventional shape',
      {
        error: 'access_denied',
        error_description: 'The user declined.',
        api_key: 'ak_live_7f3c9d02b18e4a55b6e1c4907ad3f218',
      },
      'access_denied',
      'The user declined.',
    ],
    [
      'a nested error object',
      {
        error: { type: 'invalid_grant', message: 'the grant is dead' },
        api_key: 'ak_live_7f3c9d02b18e4a55b6e1c4907ad3f218',
      },
      'invalid_grant',
      'the grant is dead',
    ],
    [
      'a form-encoded body',
      'error=authorization_pending&error_description=Waiting+for+approval' +
        '&api_key=ak_live_7f3c9d02b18e4a55b6e1c4907ad3f218',
      'authorization_pending',
      'Waiting for approval',
    ],
  ])(
    'still reports an error a 200 body names in %s, without the body around it',
    async (_label, body, expectedError, expectedDetail) => {
      const error = await pollDeviceToken({
        provider: custom(),
        clientId: 'shaping-client',
        device,
        fetchImpl: answering(body),
      }).catch((caught: Error) => caught)

      expect(error).toMatchObject({
        code: 'device_flow_failed',
        providerError: expectedError,
        status: 200,
      })
      expect((error as Error).message).toContain(expectedDetail)
      expect((error as Error).message).not.toContain('ak_live_')
      expect((error as Error).message).not.toContain('api_key')
    },
  )

  it('reports a description a 200 body gives without an error code', async () => {
    const error = await pollDeviceToken({
      provider: custom(),
      clientId: 'shaping-client',
      device,
      fetchImpl: answering({
        error_description: 'device code expired',
        api_key: 'ak_live_7f3c9d02b18e4a55b6e1c4907ad3f218',
      }),
    }).catch((caught: Error) => caught)

    expect(error).toMatchObject({ code: 'device_flow_failed', status: 200 })
    expect((error as Error).message).toContain('device code expired')
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

  // The status path reads the same shapes as the 200 path — a 400 that nests
  // its error used to be reported as `unknown_error` with the whole body
  // quoted after it.
  it('names a nested error on a failure status too', async () => {
    const error = await pollDeviceToken({
      provider: custom(),
      clientId: 'shaping-client',
      device,
      fetchImpl: answering({ error: { type: 'invalid_grant', message: 'the grant is dead' } }, 400),
    }).catch((caught: Error) => caught)

    expect(error).toMatchObject({
      code: 'device_flow_failed',
      providerError: 'invalid_grant',
      status: 400,
    })
    expect((error as Error).message).toContain('the grant is dead')
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

/*
 * `JSON.parse` accepts more than objects. A body of literal `null` used to make
 * every field read a TypeError rather than a poll failure — the same shape of
 * bug the pending-authorization registry carried.
 */
describe('a poll response that parses but is not an object', () => {
  it.each(['null', '3', '"a string"'])('fails as a poll error, not a TypeError: %s', async (body) => {
    const error = await pollDeviceToken({
      provider: custom(),
      clientId: 'shaping-client',
      device,
      fetchImpl: answering(body) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught)

    expect((error as Error).message).not.toContain('Cannot read properties')
    expect((error as { code?: string }).code).toBe('invalid_token_response')
  })
})
