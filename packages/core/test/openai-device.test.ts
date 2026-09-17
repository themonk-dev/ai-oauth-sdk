import { describe, expect, it } from 'vitest'

import { openai } from '../src/providers/openai.js'
import { REDACTED } from '../src/redact.js'
import { openaiDeviceFlow } from '../src/receivers/openai-device.js'

/** Serves a scripted sequence of responses and records what it was asked. */
function stubFetch(steps: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: unknown }> = []
  let index = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    // The device steps send JSON; the final exchange is form-encoded, so keep
    // the raw string when it does not parse.
    const raw = init?.body === undefined ? undefined : String(init.body)
    let body: unknown = raw

    try {
      body = raw === undefined ? undefined : JSON.parse(raw)
    } catch {
      body = raw
    }

    calls.push({ url, body })
    const step = steps[Math.min(index++, steps.length - 1)]!

    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

const started = { device_auth_id: 'dev-1', user_code: 'ABCD-12345', interval: '0' }

describe("OpenAI's device flow, which is not RFC 8628", () => {
  it('asks for a user code with a JSON body', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: started }])
    const device = await openaiDeviceFlow.start({
      provider: openai,
      clientId: 'app_x',
      fetchImpl,
    })

    expect(calls[0]?.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
    expect(calls[0]?.body).toEqual({ client_id: 'app_x' })
    expect(device.userCode).toBe('ABCD-12345')
    expect(device.deviceCode).toBe('dev-1')
    expect(device.verificationUri).toBe('https://auth.openai.com/codex/device')
  })

  // 403 and 404 are how this endpoint says "not approved yet". Treating either
  // as terminal would abandon a login the user is midway through completing.
  it.each([403, 404])('keeps polling through HTTP %i', async (pending) => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: started },
      { status: pending },
      { status: 200, body: { authorization_code: 'ac_1', code_verifier: 'v_from_server' } },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    ])

    const device = await openaiDeviceFlow.start({ provider: openai, clientId: 'app_x', fetchImpl })
    const tokens = await openaiDeviceFlow.poll({
      provider: openai,
      clientId: 'app_x',
      device: { ...device, intervalMs: 0 },
      fetchImpl,
    })

    expect(tokens.accessToken).toBe('at')
    // The verifier is the server's, not one we derived — that is the whole
    // reason this cannot reuse the RFC 8628 path.
    const exchange = calls.at(-1)!
    expect(exchange.url).toBe('https://auth.openai.com/oauth/token')
    expect(String(exchange.body)).toContain('code_verifier=v_from_server')
  })

  it('exchanges the approval through the ordinary token endpoint', async () => {
    const bodies: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))

      if (url.endsWith('/deviceauth/token')) {
        return new Response(
          JSON.stringify({ authorization_code: 'ac_1', code_verifier: 'v_from_server' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return new Response(JSON.stringify({ access_token: 'at', expires_in: 60 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await openaiDeviceFlow.poll({
      provider: openai,
      clientId: 'app_x',
      device: {
        deviceCode: 'dev-1',
        userCode: 'ABCD-12345',
        verificationUri: 'https://auth.openai.com/codex/device',
        expiresAt: Date.now() + 60_000,
        intervalMs: 0,
      },
      fetchImpl,
    })

    const exchange = new URLSearchParams(bodies.at(-1)!)
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('ac_1')
    expect(exchange.get('code_verifier')).toBe('v_from_server')
    expect(exchange.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
  })

  it('quotes the provider when the request is refused', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, body: { detail: 'unknown client' } }])
    await expect(
      openaiDeviceFlow.start({ provider: openai, clientId: 'nope', fetchImpl }),
    ).rejects.toThrowError(/unknown client/)
  })
})

/*
 * `device_auth_id` + `user_code` are not identifiers, they are the approval
 * credential: posting the pair to the poll endpoint returns the authorization
 * code *and* the server-generated verifier, so a reader of the log can finish
 * the sign-in with nothing else but the published client id.
 */
describe('a failed poll never quotes the device codes back', () => {
  const device = {
    deviceCode: 'da_01JQZK9Wb4X7yQ2n8VtR3sMhKq',
    userCode: 'WXYZ-1234',
    verificationUri: 'https://auth.openai.com/codex/device',
    expiresAt: Date.now() + 60_000,
    intervalMs: 0,
  }

  const failWith = (status: number, body: string) =>
    openaiDeviceFlow
      .poll({
        provider: openai,
        clientId: 'app_x',
        device,
        fetchImpl: (async () =>
          new Response(body, {
            status,
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch,
      })
      .catch((caught: Error) => caught)

  it('redacts them when a gateway reflects the poll body', async () => {
    const error = await failWith(
      502,
      `Bad gateway. Upstream received: ${JSON.stringify({
        device_auth_id: device.deviceCode,
        user_code: device.userCode,
      })}`,
    )

    const serialized = `${(error as Error).message} ${JSON.stringify(error)}`
    expect(serialized).not.toContain(device.deviceCode)
    expect(serialized).not.toContain(device.userCode)
    expect(serialized).toContain(REDACTED)
    expect((error as Error).message).toContain('502')
  })

  /*
   * The reflected shape is the easy half. A provider naming the codes in its
   * own prose leaks exactly the same pair, and there is no `key: value` there
   * for the parameter-name redaction to find — which is why the live values are
   * scrubbed by value rather than by name.
   */
  it('redacts them when the provider names them in prose', async () => {
    const error = await failWith(
      409,
      JSON.stringify({
        detail: `device authorization ${device.deviceCode} for user_code ${device.userCode} is in an invalid state`,
      }),
    )

    const serialized = `${(error as Error).message} ${JSON.stringify(error)}`
    expect(serialized).not.toContain(device.deviceCode)
    expect(serialized).not.toContain(device.userCode)
    // The diagnostic survives the scrub; only the two values go.
    expect((error as Error).message).toContain('is in an invalid state')
    expect(error).toMatchObject({ code: 'device_flow_failed', status: 409 })
  })
})

describe('the OpenAI device flow clamps what the server reports', () => {
  const start = (body: Record<string, unknown>) =>
    openaiDeviceFlow.start({
      provider: openai,
      clientId: 'app_x',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-12345', ...body }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    })

  it('floors a tiny positive interval, which would otherwise poll flat out', async () => {
    expect((await start({ interval: '0.001' })).intervalMs).toBe(1000)
  })

  it('caps an interval that would overflow setTimeout', async () => {
    expect((await start({ interval: '1e12' })).intervalMs).toBe(60_000)
  })

  it('still defaults when the interval is absent, zero or not a number', async () => {
    expect((await start({})).intervalMs).toBe(5000)
    expect((await start({ interval: '0' })).intervalMs).toBe(5000)
    expect((await start({ interval: 'soon' })).intervalMs).toBe(5000)
  })

  it('honours a sane interval unchanged', async () => {
    expect((await start({ interval: '7' })).intervalMs).toBe(7000)
  })

  it('caps an expiry in 2099, which is the poll loop’s only exit', async () => {
    const device = await start({ expires_at: '2099-01-01T00:00:00Z' })
    expect(device.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000)
  })

  it('honours a sane expiry, and defaults without one', async () => {
    const at = new Date(Date.now() + 600_000).toISOString()
    expect((await start({ expires_at: at })).expiresAt).toBeCloseTo(Date.parse(at), -3)
    expect((await start({})).expiresAt).toBeCloseTo(Date.now() + 15 * 60 * 1000, -3)
  })
})
