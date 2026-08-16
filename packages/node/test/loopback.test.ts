import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuthClient, defineProvider, memoryStorage, type ProviderConfig } from '@ai-oauth-sdk/core'

import { loopbackReceiver } from '../src/loopback.js'
import {
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../core/test/helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    scopes: ['openid'],
    redirect: { mode: 'loopback', loopbackPort: 0 },
    ...overrides,
  })

/**
 * Stands in for the user's browser: follows the 302 from the authorization
 * endpoint into the loopback server, exactly as a real browser would.
 */
const fakeBrowser = (url: string) => {
  void fetch(url, { redirect: 'follow' }).catch(() => {})
}

/**
 * A raw `GET` that sends the headers it is given, verbatim.
 *
 * `fetch()` cannot stand in here: undici owns `Sec-Fetch-Mode` and rewrites
 * whatever you pass to `cors`, which is precisely the value under test. It
 * sends no `Sec-Fetch-Site` at all, which is why the plain `fetch()` cases
 * elsewhere in this file still reach the handler.
 */
const rawGet = (url: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const call = httpRequest(url, { headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    call.on('error', reject)
    call.end()
  })

/** The shape a browser puts on a `<img src>`/`fetch()` hit from another page. */
const driveByHeaders = {
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Dest': 'image',
}

/** The shape a browser puts on the provider's redirect back to us. */
const navigationHeaders = {
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
}

/**
 * Whether this kernel has IPv6 at all.
 *
 * Where it does not, `localhost` cannot resolve to `::1` either, so there is no
 * second address for anyone to contest and the receiver's degraded IPv4-only
 * bind already covers the name completely. The dual-stack cases below are
 * skipped there and run on CI, which is dual-stack.
 */
const hasIpv6 = await new Promise<boolean>((resolve) => {
  const probe = createServer()
  probe.once('error', () => resolve(false))
  probe.listen(0, '::1', () => probe.close(() => resolve(true)))
})

/** Whether a promise has settled, without consuming its result. */
const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  const pending = Symbol('pending')
  const raced = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), 50)),
  ])

  return raced !== pending
}

beforeEach(async () => {
  server = await startFakeAuthServer()
})

afterEach(async () => {
  await server.close()
})

describe('loopbackReceiver', () => {
  it('completes a real browser round-trip over HTTP', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })

    const tokens = await client.login({
      receiver: loopbackReceiver({ port: 0 }),
      openUrl: fakeBrowser,
    })

    expect(tokens.accessToken).toBe('access-1')
    expect(server.requests[0]?.['grant_type']).toBe('authorization_code')
    expect(server.requests[0]?.['code_verifier']).toBeTruthy()
  })

  it('binds an ephemeral port and reports it in the redirect URI', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })

    try {
      const url = new URL(started.redirectUri)
      expect(url.hostname).toBe('localhost')
      expect(Number(url.port)).toBeGreaterThan(0)
      expect(url.pathname).toBe('/callback')
    } finally {
      await started.close()
    }
  })

  it("honours the provider's declared port and path", async () => {
    const provider = testProvider(server.url, {
      redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/auth/callback' },
    })
    const started = await loopbackReceiver().start({ provider })

    try {
      expect(new URL(started.redirectUri).pathname).toBe('/auth/callback')
    } finally {
      await started.close()
    }
  })

  it('serves a success page to the browser', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    let callbackBody = ''

    await client.login({
      receiver: loopbackReceiver({ port: 0 }),
      openUrl: (url) => {
        void fetch(url, { redirect: 'follow' })
          .then((response) => response.text())
          .then((body) => {
            callbackBody = body
          })
          .catch(() => {})
      },
    })

    // Give the browser response a turn to be read.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(callbackBody).toContain('Signed in')
  })

  it('404s paths other than the callback path', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })

    try {
      const base = new URL(started.redirectUri)
      const response = await fetch(`${base.origin}/some/other/path`)
      expect(response.status).toBe(404)
    } finally {
      await started.close()
    }
  })

  it('rejects when the provider reports a denial', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })
    const waiting = started.wait()

    try {
      const response = await fetch(`${started.redirectUri}?error=access_denied&error_description=nope`)
      expect(response.status).toBe(400)
      await expect(waiting).rejects.toMatchObject({
        code: 'authorization_denied',
        providerError: 'access_denied',
      })
    } finally {
      await started.close()
    }
  })

  it('refuses methods a browser navigation would never use', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })

    try {
      for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const response = await fetch(started.redirectUri, { method })
        // Any local process can reach a loopback port; keep the surface narrow.
        expect(response.status, method).toBe(405)
        expect(response.headers.get('allow')).toBe('GET, HEAD')
      }
    } finally {
      await started.close()
    }
  })

  it('tells caches and referrers not to keep the callback URL', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })

    try {
      const response = await fetch(`${started.redirectUri}?code=abc&state=xyz`)
      // The URL carries the authorization code, so it must not be cached or
      // leak through a Referer header.
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      await started.close()
    }
  })

  it('reports a port collision clearly', async () => {
    const provider = testProvider(server.url)
    const first = await loopbackReceiver({ port: 0 }).start({ provider })

    try {
      const port = Number(new URL(first.redirectUri).port)
      await expect(loopbackReceiver({ port }).start({ provider })).rejects.toMatchObject({
        code: 'configuration_error',
      })
    } finally {
      await first.close()
    }
  })

  it('stops listening after close', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })
    const origin = new URL(started.redirectUri).origin
    await started.close()

    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  })

  it('refuses a request the browser marks as a subresource, and survives it', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })
    const waiting = started.wait()

    try {
      // Any page the user has open can fire this at a fixed loopback port.
      const driveBy = await rawGet(`${started.redirectUri}?error=access_denied`, driveByHeaders)
      expect(driveBy.status).toBe(403)

      // The login it tried to cancel is still running.
      expect(await isSettled(waiting)).toBe(false)

      const real = await rawGet(`${started.redirectUri}?code=abc&state=xyz`, navigationHeaders)
      expect(real.status).toBe(200)
      await expect(waiting).resolves.toMatchObject({ code: 'abc', state: 'xyz' })
    } finally {
      await started.close()
    }
  })

  it('refuses an embedded navigation, which a subresource check on the mode alone would miss', async () => {
    // A hidden cross-origin `<iframe>` is a navigation, so `Sec-Fetch-Mode`
    // says `navigate` and only the destination gives it away. The loopback
    // origin is potentially trustworthy, so an https page can embed one
    // without tripping mixed content — same drive-by, nothing to notice.
    for (const dest of ['iframe', 'frame', 'object', 'embed']) {
      const started = await loopbackReceiver({ port: 0 }).start({
        provider: testProvider(server.url),
      })
      const waiting = started.wait()

      try {
        const embedded = await rawGet(`${started.redirectUri}?error=access_denied`, {
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': dest,
        })

        expect(embedded.status, `Sec-Fetch-Dest: ${dest}`).toBe(403)
        expect(await isSettled(waiting), `Sec-Fetch-Dest: ${dest}`).toBe(false)
      } finally {
        await started.close()
      }
    }
  })

  it('accepts the top-level navigation the provider actually sends', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })
    const waiting = started.wait()

    try {
      const response = await rawGet(`${started.redirectUri}?code=abc&state=xyz`, navigationHeaders)
      expect(response.status).toBe(200)
      await expect(waiting).resolves.toMatchObject({ code: 'abc', state: 'xyz' })
    } finally {
      await started.close()
    }
  })

  it('accepts a caller that sends no fetch metadata at all', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })
    const waiting = started.wait()

    try {
      // curl, undici and every other non-browser client. The check only has an
      // opinion when the browser itself supplied one.
      const response = await rawGet(`${started.redirectUri}?code=abc&state=xyz`)
      expect(response.status).toBe(200)
      await expect(waiting).resolves.toMatchObject({ code: 'abc' })
    } finally {
      await started.close()
    }
  })

  it('serves exactly one callback and then stops listening', async () => {
    const started = await loopbackReceiver({ port: 0 }).start({ provider: testProvider(server.url) })
    const waiting = started.wait()

    try {
      const first = await rawGet(`${started.redirectUri}?code=first&state=xyz`, navigationHeaders)
      expect(first.status).toBe(200)
      expect(first.body).toContain('Signed in')
      await expect(waiting).resolves.toMatchObject({ code: 'first' })

      // The receiver retires itself; the caller's close() is a backstop, not
      // what makes this true.
      await expect(rawGet(`${started.redirectUri}?code=second&state=xyz`, navigationHeaders)).rejects.toThrow()
      await expect(waiting).resolves.toMatchObject({ code: 'first' })
    } finally {
      await started.close()
    }
  })

  it('aborts on signal', async () => {
    const controller = new AbortController()
    const started = await loopbackReceiver({ port: 0 }).start({
      provider: testProvider(server.url),
      signal: controller.signal,
    })
    const waiting = started.wait()
    controller.abort()

    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
    await started.close()
  })

  // The receiver binds `127.0.0.1`; the redirect URI it advertises names
  // `localhost`, which on a dual-stack machine also resolves to `::1` — and
  // browsers try `::1` first. Binding one address while promising a name lets
  // another local process own the address the browser actually reaches, and
  // because port reservation is per address the `EADDRINUSE` guard never fires.
  describe('binds every address the advertised host resolves to', () => {
    it.skipIf(!hasIpv6)('answers on ::1 as well as 127.0.0.1', async () => {
      const started = await loopbackReceiver({ port: 0 }).start({
        provider: testProvider(server.url),
      })
      const port = new URL(started.redirectUri).port

      try {
        // The advertised URI still names `localhost` — nothing about what the
        // authorization server is told changes. Only the coverage does.
        expect(started.redirectUri).toContain('localhost')
        const viaIpv6 = await rawGet(`http://[::1]:${port}/callback?code=six&state=xyz`, navigationHeaders)
        expect(viaIpv6.status).toBe(200)
        await expect(started.wait()).resolves.toMatchObject({ code: 'six' })
      } finally {
        await started.close()
      }
    })

    it.skipIf(!hasIpv6)('refuses a fixed port whose sibling address is held', async () => {
      // A squatter on `[::1]:PORT` is the attack: our own bind on 127.0.0.1
      // succeeds, the login looks normal, and the browser hands the code to
      // them. On a fixed published port there is nowhere else to go, so the
      // login is refused rather than started.
      const squatter = createServer()
      await new Promise<void>((resolve) => squatter.listen(0, '::1', resolve))
      const port = (squatter.address() as AddressInfo).port

      try {
        await expect(
          loopbackReceiver({ port }).start({ provider: testProvider(server.url) }),
        ).rejects.toMatchObject({
          code: 'configuration_error',
          message: expect.stringMatching(/held by another process/),
        })
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()))
      }
    })

    it.skipIf(!hasIpv6)('moves to another port when an ephemeral sibling is held', async () => {
      // Same squatter, but the provider asked for any free port, so a collision
      // is as likely to be ordinary as hostile. Take a different one.
      const squatter = createServer()
      await new Promise<void>((resolve) => squatter.listen(0, '::1', resolve))
      const taken = (squatter.address() as AddressInfo).port

      const started = await loopbackReceiver({ port: 0 }).start({
        provider: testProvider(server.url),
      })

      try {
        expect(new URL(started.redirectUri).port).not.toBe(String(taken))
        const viaIpv6 = await rawGet(
          `http://[::1]:${new URL(started.redirectUri).port}/callback?code=moved&state=xyz`,
          navigationHeaders,
        )
        expect(viaIpv6.status).toBe(200)
      } finally {
        await started.close()
        await new Promise<void>((resolve) => squatter.close(() => resolve()))
      }
    })

    it('leaves a provider that advertises the IP literal on one address', async () => {
      // `xai` already names `127.0.0.1`, which nothing else can answer for, so
      // there is no sibling to cover and no second bind to attempt.
      const started = await loopbackReceiver({ port: 0 }).start({
        provider: testProvider(server.url, {
          redirect: { mode: 'loopback', loopbackPort: 0, loopbackHost: '127.0.0.1' },
        }),
      })

      try {
        expect(started.redirectUri).toContain('127.0.0.1')
        const result = await rawGet(`${started.redirectUri}?code=literal&state=xyz`, navigationHeaders)
        expect(result.status).toBe(200)
      } finally {
        await started.close()
      }
    })
  })
})
