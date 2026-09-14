import { describe, expect, it } from 'vitest'

import { openai } from '../src/providers/openai.js'
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

  it('clamps a poll interval and a deadline it was handed', async () => {
    // Both values are the server's, and both are load-bearing here: an interval
    // of a millisecond is an unthrottled flood of an OpenAI endpoint from every
    // client that got the response, and a year-out `expires_at` holds the loop
    // open for a year. The string is what OpenAI really sends, so the coercion
    // has to happen before the clamp — otherwise the clamp reads every real
    // response as absent and quietly hands back the fallback.
    const { fetchImpl } = stubFetch([
      {
        status: 200,
        body: { ...started, interval: '0.001', expires_at: '2999-01-01T00:00:00Z' },
      },
    ])

    const device = await openaiDeviceFlow.start({ provider: openai, clientId: 'app_x', fetchImpl })

    expect(device.intervalMs).toBeGreaterThanOrEqual(1000)
    expect(device.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000)
  })

  it('leaves a realistic response exactly as the server sent it', async () => {
    // The clamp is a bound, not a rewrite: a server behaving normally must see
    // its own numbers come back, or the coercion bug above would be invisible.
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ...started, interval: '5', expires_at: expiresAt } },
    ])

    const device = await openaiDeviceFlow.start({ provider: openai, clientId: 'app_x', fetchImpl })

    expect(device.intervalMs).toBe(5000)
    expect(device.expiresAt).toBe(Date.parse(expiresAt))
  })

  it('quotes the provider when the request is refused', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, body: { detail: 'unknown client' } }])
    await expect(
      openaiDeviceFlow.start({ provider: openai, clientId: 'nope', fetchImpl }),
    ).rejects.toThrowError(/unknown client/)
  })
})
