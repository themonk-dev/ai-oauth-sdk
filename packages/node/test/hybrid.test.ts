import { createServer, request as httpRequest, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineProvider } from '@ai-oauth-sdk/core'

import { hybridReceiver } from '../src/hybrid.js'

/**
 * Every browser launch either half makes, without launching one.
 *
 * Both `loopbackReceiver` and `promptReceiver` reach for this same module, so
 * one stub counts both — which is the point: presenting both halves must still
 * open exactly one window.
 */
const { browserLaunches } = vi.hoisted(() => ({ browserLaunches: [] as string[] }))

vi.mock('../src/browser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser.js')>()),
  openBrowser: (url: string) => {
    browserLaunches.push(url)
  },
}))

const provider = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  /** Port 0 so the test never collides with a real service. */
  redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/callback' },
})

const silent = { openBrowser: false, message: () => '' }

/**
 * A raw `GET` that sends the headers it is given, verbatim.
 *
 * `fetch()` cannot stand in: undici owns `Sec-Fetch-Mode` and rewrites whatever
 * you pass to `cors`, so the attack below would be turned away by the metadata
 * check rather than by the `state` comparison it is meant to exercise — a false
 * pass. `packages/node/test/loopback.test.ts` carries the same helper.
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

/**
 * The shape a browser puts on the provider's redirect back to us — and,
 * identically, on a page navigating the user to the same URL.
 */
const navigationHeaders = {
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
}

/**
 * Whether this kernel has IPv6 at all. Where it does not, `localhost` cannot
 * resolve to `::1` either, so there is no sibling address for anyone to contest
 * and the case below cannot arise. Skipped there, run on CI, which is
 * dual-stack.
 */
const hasIpv6 = await new Promise<boolean>((resolve) => {
  const probe = createServer()
  probe.once('error', () => resolve(false))
  probe.listen(0, '::1', () => probe.close(() => resolve(true)))
})

let squatter: Server | undefined

afterEach(async () => {
  if (squatter) {
    await new Promise<void>((resolve) => squatter!.close(() => resolve()))
    squatter = undefined
  }
})

describe('hybridReceiver', () => {
  /*
   * `--paste` used to leave the loopback port unbound, so a local browser hit
   * "This site can't be reached" and the user had to read the address bar.
   */
  it('completes from the redirect without anything being pasted', async () => {
    const started = await hybridReceiver(silent).start({ provider })

    try {
      await started.present('https://provider.test/authorize?state=xyz')

      const response = await fetch(`${started.redirectUri}?code=abc&state=xyz`)
      expect(response.status).toBe(200)

      await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'xyz' })
    } finally {
      await started.close()
    }
  })

  /*
   * The loopback half only learns the `state` it matches callbacks against from
   * `present()`, and hybrid used to present the prompt alone. That left the
   * drive-by cancellation the loopback receiver refuses wide open under
   * `--paste` — the same fixed ports, the same no-click navigation, and no
   * indication anything was different.
   */
  it('binds its loopback half to the attempt too', async () => {
    const started = await hybridReceiver(silent).start({ provider })

    try {
      await started.present('https://provider.test/authorize?state=xyz')
      const waiting = started.wait()

      const driveBy = await rawGet(`${started.redirectUri}?error=access_denied`, navigationHeaders)
      expect(driveBy.status).toBe(403)

      const real = await rawGet(`${started.redirectUri}?code=abc&state=xyz`, navigationHeaders)
      expect(real.status).toBe(200)

      await expect(waiting).resolves.toEqual({ code: 'abc', state: 'xyz' })
    } finally {
      await started.close()
    }
  })

  /*
   * Presenting the loopback half is what binds it, and `present()` is also what
   * opens a browser. Both halves would open one — the loopback receiver through
   * `context.openUrl`, the prompt through the same — so the user got two tabs
   * on the same authorization URL. The loopback half is started on a context
   * without `openUrl` for exactly this.
   */
  it('calls the caller openUrl exactly once, with both halves presented', async () => {
    const opened: string[] = []
    const started = await hybridReceiver(silent).start({
      provider,
      openUrl: (url) => {
        opened.push(url)
      },
    })

    try {
      await started.present('https://provider.test/authorize?state=xyz')

      expect(opened).toEqual(['https://provider.test/authorize?state=xyz'])
    } finally {
      await started.close()
    }
  })

  /*
   * The same count on the other branch, which is the one the CLI actually takes
   * for `--paste`: no `context.openUrl`, so the prompt launches a browser
   * itself. The loopback half's `openBrowser` is forced off, so presenting it
   * adds nothing.
   */
  it('launches a browser exactly once, with both halves presented', async () => {
    browserLaunches.length = 0
    const started = await hybridReceiver({ message: () => '' }).start({ provider })

    try {
      await started.present('https://provider.test/authorize?state=xyz')

      expect(browserLaunches).toEqual(['https://provider.test/authorize?state=xyz'])
    } finally {
      await started.close()
    }
  })

  it('advertises one redirect URI, since the token exchange replays it', async () => {
    const started = await hybridReceiver(silent).start({ provider })

    try {
      /* Bound to an ephemeral port, so the URI is only knowable after start(). */
      expect(started.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
      expect(started.redirectUri).not.toContain(':0/')
    } finally {
      await started.close()
    }
  })

  /*
   * A blank line on stdin rejects the paste half. Letting that rejection win
   * the race tore down a server that was about to receive a good callback, and
   * burned the authorization code with it.
   */
  it('ignores a failed paste and still completes from the redirect', async () => {
    const started = await hybridReceiver({
      ...silent,
      message: () => '',
    }).start({ provider })

    try {
      await started.present('https://provider.test/authorize?state=s')

      const pending = started.wait()
      process.stdin.push('\n')

      await new Promise((resolve) => setTimeout(resolve, 50))
      await fetch(`${started.redirectUri}?code=late&state=s`)

      await expect(pending).resolves.toEqual({ code: 'late', state: 's' })
    } finally {
      await started.close()
    }
  })

  /*
   * ...and the user gets to try again. Ignoring the failed paste used to also
   * mean closing the readline it was read on, so the *next* line the user typed
   * went nowhere: no error, no second prompt, and a process the loopback server
   * kept alive indefinitely. One stray newline before the real paste was enough,
   * and there is no default timeout to end it.
   *
   * Timed out well under the suite default so a regression fails here rather
   * than hanging CI for twenty seconds.
   */
  it(
    'asks again after an unparseable paste, and reads the next one',
    async () => {
      const started = await hybridReceiver(silent).start({ provider })

      try {
        await started.present('https://provider.test/authorize?state=s')

        const pending = started.wait()
        process.stdin.push('not a redirect url at all\n')

        /* Long enough for the failed paste to be read, reported, and re-asked;
           pushing both lines at once would deliver the second one while no
           question was pending. */
        await new Promise((resolve) => setTimeout(resolve, 100))
        process.stdin.push('https://provider.test/callback?code=second&state=s\n')

        await expect(pending).resolves.toEqual({ code: 'second', state: 's' })
      } finally {
        await started.close()
      }
    },
    5_000,
  )

  /*
   * The same wedge with no user error in it at all: the user clicks Deny at the
   * provider and pastes the `?error=access_denied` URL it hands back. That is an
   * answer, not a slip, so it ends the login — the way the identical denial
   * already does when it arrives on the loopback port instead.
   */
  it(
    'ends the login when the paste is the provider saying no',
    async () => {
      const started = await hybridReceiver(silent).start({ provider })

      try {
        await started.present('https://provider.test/authorize?state=s')

        const pending = started.wait()
        process.stdin.push('https://provider.test/callback?error=access_denied&state=s\n')

        await expect(pending).rejects.toMatchObject({
          code: 'authorization_denied',
          providerError: 'access_denied',
        })
      } finally {
        await started.close()
      }
    },
    5_000,
  )

  /*
   * The sandbox case --paste exists for: this process cannot listen at all, so
   * the redirect URI it advertises is unclaimed by anyone and the worst that
   * happens is the user copies a code. `listen()` refused by seccomp or by a
   * dropped capability reports EPERM/EACCES/ENOTSUP, none of which can be
   * provoked portably from a test; an address that is simply not on this host
   * fails the same way — a raw errno out of listen() rather than a decision by
   * the receiver — which is the distinction the fallback turns on.
   */
  it('falls back to pasting when listen() itself is refused', async () => {
    const started = await hybridReceiver({ ...silent, host: '203.0.113.1' }).start({ provider })

    try {
      expect(started.redirectUri).toContain('/callback')
      /* The prompt's own synthesised URI, since no server ever bound. */
      expect(started.redirectUri).toContain(':1455/')
    } finally {
      await started.close()
    }
  })

  /*
   * This used to assert the fallback. It is not the sandbox case at all: a live
   * squatter on the advertised port is the attack loopbackReceiver() was
   * changed to refuse, and hybrid discarding that refusal made --paste the way
   * around it. The CLI routes every provider without a hosted page through this
   * receiver, so `login xai --paste` against a squatted 127.0.0.1:56121 would
   * have printed an authorization URL naming the squatter's socket and waited
   * at the prompt while the browser handed them the code.
   */
  it('refuses the login when the advertised port is already held', async () => {
    squatter = createServer(() => {})
    await new Promise<void>((resolve) => squatter!.listen(0, '127.0.0.1', () => resolve()))
    const held = (squatter.address() as { port: number }).port

    const fixedPort = defineProvider({
      ...provider,
      redirect: { mode: 'loopback', loopbackPort: held, loopbackPath: '/callback' },
    })

    await expect(
      hybridReceiver({ ...silent, port: held }).start({ provider: fixedPort }),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/already in use/),
    })
  })

  /*
   * The sibling-address refusal reaches the caller the same way. Holding
   * `[::1]:port` while `127.0.0.1:port` stays free is the shape of the attack
   * on a name like `localhost`: our own bind succeeds, so only the receiver's
   * own refusal stands between the user and a squatted callback.
   */
  it.skipIf(!hasIpv6)('refuses the login when the sibling address is held', async () => {
    const onIpv4 = createServer(() => {})
    await new Promise<void>((resolve) => onIpv4.listen(0, '127.0.0.1', () => resolve()))
    const port = (onIpv4.address() as { port: number }).port
    squatter = createServer(() => {})
    await new Promise<void>((resolve, reject) => {
      squatter!.once('error', reject)
      squatter!.listen(port, '::1', () => resolve())
    })
    await new Promise<void>((resolve) => onIpv4.close(() => resolve()))

    const fixedPort = defineProvider({
      ...provider,
      redirect: { mode: 'loopback', loopbackPort: port, loopbackPath: '/callback' },
    })

    await expect(
      hybridReceiver({ ...silent, port }).start({ provider: fixedPort }),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/held by another process/),
    })
  })
})
