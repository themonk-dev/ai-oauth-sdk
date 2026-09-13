/**
 * `EADDRINUSE` is not the only way a kernel says a port is taken.
 *
 * libuv binds with neither `SO_REUSEADDR` nor `SO_EXCLUSIVEADDRUSE`, and on
 * Windows a second bind against that arrangement reports `WSAEACCES` — `EACCES`
 * here — rather than `EADDRINUSE`. `hybridReceiver` tells a refusal from an
 * unusable machine by *type*: an `OAuthError` is a refusal and a bare errno is
 * a kernel saying no, which degrades to `--paste`. So a squatted port that
 * reported `EACCES` degraded, and the paste half then advertised the provider's
 * fixed loopback URI while the squatter was still on it — the exact bypass the
 * sibling-address refusal was written to close.
 *
 * The errno cannot be provoked portably (on Linux a held port is always
 * `EADDRINUSE`, and this suite may run as root), so the bind is failed
 * directly at `Server.prototype.listen`, which is the seam libuv reports
 * through.
 */
import { Server } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineProvider } from '@ai-oauth-sdk/core'

import { hybridReceiver } from '../src/hybrid.js'
import { loopbackReceiver } from '../src/loopback.js'

vi.mock('../src/browser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser.js')>()),
  openBrowser: () => {},
}))

const FIXED_PORT = 1455

const fixedPortProvider = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  redirect: { mode: 'loopback', loopbackPort: FIXED_PORT, loopbackPath: '/callback' },
})

const silent = { openBrowser: false, message: () => '' }

const realListen = Server.prototype.listen

/**
 * Fails every bind with `code`, as libuv would.
 *
 * The error is emitted rather than thrown, because that is how a failed bind
 * reaches `listen()`/`tryListen()` — both of them wait on the `'error'` event.
 */
const failBindWith = (code: string): void => {
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
    process.nextTick(() => {
      const error: NodeJS.ErrnoException = new Error(`listen ${code}`)
      error.code = code
      this.emit('error', error)
    })

    return this
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  Server.prototype.listen = realListen
})

describe('a fixed port refused with EACCES is read as held, not as an unusable machine', () => {
  it('refuses the login rather than starting one it cannot receive', async () => {
    failBindWith('EACCES')

    await expect(
      loopbackReceiver({ openBrowser: false }).start({ provider: fixedPortProvider }),
    ).rejects.toMatchObject({ name: 'OAuthError', code: 'configuration_error' })
  })

  it('does not let --paste advertise a URI the squatter still holds', async () => {
    failBindWith('EACCES')

    /* The security-relevant half. Before the fix this resolved, and the paste
       prompt advertised http://localhost:1455/callback while someone else was
       listening on it — so the browser handed them the code. */
    await expect(
      hybridReceiver({ ...silent }).start({ provider: fixedPortProvider }),
    ).rejects.toMatchObject({ name: 'OAuthError', code: 'configuration_error' })
  })

  it('names the port in the refusal, so the user can free it', async () => {
    failBindWith('EACCES')

    await expect(
      loopbackReceiver({ openBrowser: false }).start({ provider: fixedPortProvider }),
    ).rejects.toThrow(String(FIXED_PORT))
  })
})

describe('the sandbox case still degrades', () => {
  /**
   * `--paste` exists for a machine that cannot listen at all: nothing claims
   * the advertised URI, so the worst that happens is the user copies a code.
   * Containers that forbid `listen()` report `EPERM` — Docker's default seccomp
   * profile among them — which must keep degrading.
   */
  it('falls back to pasting when a fixed bind is refused with EPERM', async () => {
    failBindWith('EPERM')

    const started = await hybridReceiver({ ...silent }).start({ provider: fixedPortProvider })

    try {
      expect(started.redirectUri).toContain(`:${FIXED_PORT}/`)
    } finally {
      await started.close()
    }
  })

  it('falls back to pasting when an ephemeral bind is refused with EACCES', async () => {
    failBindWith('EACCES')

    /* Port 0 names no published address, so there is nothing for anyone to be
       holding and nothing at stake in degrading. */
    const ephemeral = defineProvider({
      ...fixedPortProvider,
      redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/callback' },
    })
    const started = await hybridReceiver({ ...silent, port: 0 }).start({ provider: ephemeral })

    try {
      expect(started.redirectUri).toContain('/callback')
    } finally {
      await started.close()
    }
  })
})
