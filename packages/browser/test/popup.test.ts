// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { claude, defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { announceCallback, popupReceiver, postCallbackToOpener } from '../src/popup.js'

const provider: ProviderConfig = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
})

/**
 * Stands in for `claude.ai`: an authorization page whose enforced
 * `Cross-Origin-Opener-Policy: same-origin` severs `window.opener` and lies
 * about `.closed`. jsdom does not implement COOP itself, so these tests pin
 * the receiver's *reaction* to that fact — reading `authPage.seversOpener` and
 * skipping the close-poll, completing from the `BroadcastChannel` alone —
 * rather than the browsing-context swap itself.
 */
const severingProvider: ProviderConfig = defineProvider({
  ...provider,
  id: 'severing-test',
  authPage: { seversOpener: true },
})

interface FakePopup {
  closed: boolean
  close: () => void
}

let popup: FakePopup
let openSpy: ReturnType<typeof vi.fn>
let closeSpy: MockInstance<() => void>

beforeEach(() => {
  popup = { closed: false, close: vi.fn(() => void (popup.closed = true)) }
  openSpy = vi.fn(() => popup)
  vi.stubGlobal('open', openSpy)
  // Both halves of the redirect page close the window they run on, and jsdom
  // takes that literally enough to tear down the test environment.
  closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Delivers a message the way the redirect page's postMessage would. */
function deliverCallback(payload: string, origin = window.location.origin) {
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'aioauth:callback', payload }, origin }),
  )
}

/** The redirect page's channel half, without the acknowledgement bookkeeping. */
function broadcastCallback(payload: string) {
  const channel = new BroadcastChannel('aioauth:callback-channel')

  channel.postMessage({ kind: 'callback', payload })
  channel.close()
}

/**
 * An older redirect page's acknowledgement: a receiver from before
 * announcements carried ids, which echoes nothing back.
 */
function acknowledgeWithoutId() {
  const channel = new BroadcastChannel('aioauth:callback-channel')

  channel.postMessage({ kind: 'received' })
  channel.close()
}

/** An acknowledgement naming an announcement that is not the one under test. */
function acknowledgeSomeoneElse() {
  const channel = new BroadcastChannel('aioauth:callback-channel')

  channel.postMessage({ kind: 'received', id: 'a-different-announcement' })
  channel.close()
}

/** Lets a posted `BroadcastChannel` message reach its listeners. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Whether a receiver has settled either way, without consuming the outcome. */
function watch(started: { wait: () => Promise<unknown> }) {
  const state = { settled: false }

  started.wait().then(
    () => (state.settled = true),
    () => (state.settled = true),
  )

  return state
}

describe('popupReceiver', () => {
  it('opens a popup and resolves when the callback arrives', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()

    await started.present('https://provider.test/authorize?x=1')
    expect(openSpy).toHaveBeenCalledOnce()
    expect(openSpy.mock.calls[0]?.[0]).toBe('https://provider.test/authorize?x=1')

    deliverCallback('?code=abc&state=xyz')
    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'xyz' })

    await started.close()
  })

  it('ignores messages from another origin', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    // A hostile frame must not be able to inject an authorization code.
    deliverCallback('?code=attacker&state=xyz', 'https://evil.test')

    const outcome = await Promise.race([
      waiting.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('ignored'), 50)),
    ])
    expect(outcome).toBe('ignored')

    await started.close()
  })

  it('ignores unrelated messages on the same origin', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'something-else' }, origin: window.location.origin }),
    )
    window.dispatchEvent(new MessageEvent('message', { data: null, origin: window.location.origin }))

    const outcome = await Promise.race([
      waiting.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('ignored'), 50)),
    ])
    expect(outcome).toBe('ignored')

    await started.close()
  })

  it('rejects when the user closes the popup', async () => {
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 10,
    }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    popup.closed = true
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })

    await started.close()
  })

  it('reports a blocked popup with actionable advice', async () => {
    openSpy.mockReturnValue(null)
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })

    await expect(started.present('https://provider.test/authorize')).rejects.toMatchObject({
      code: 'unsupported_runtime',
    })
    await expect(started.present('https://provider.test/authorize')).rejects.toThrow(/user gesture/)
  })

  it('surfaces a provider denial', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    deliverCallback('?error=access_denied&error_description=nope')
    await expect(waiting).rejects.toMatchObject({
      code: 'authorization_denied',
      providerError: 'access_denied',
    })

    await started.close()
  })

  it('closes the popup and stops listening on close()', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    await started.present('https://provider.test/authorize')
    await started.close()

    expect(popup.close).toHaveBeenCalled()
  })

  it('aborts on signal', async () => {
    const controller = new AbortController()
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider,
      signal: controller.signal,
    })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })

    await started.close()
  })

  /**
   * A `postMessage` reaches the window that opened the popup and nowhere else,
   * so with one sign-in in flight there is no second attempt it could have been
   * meant for and nothing for the receiver to rule on. A payload whose `state`
   * does not match is handed over regardless, because the client holds the
   * authoritative `state` and would rather fail loudly on it than have this
   * receiver drop the callback and hang.
   *
   * The payload is a whole `window.location.href` with a fragment on it, which
   * is what an app passing `window.location.href` rather than the default
   * `window.location.search` gives `postCallbackToOpener`. The fragment is the
   * provider's, not part of the `state`, and `parseStandardCallback` splits it
   * off before reading either — so what arrives is a clean `state` that happens
   * not to be this attempt's.
   */
  it('hands a postMessage callback through whatever its state looks like', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider,
    })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize?state=mine')

    deliverCallback('https://app.test/callback?code=abc&state=stale#_=_')

    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'stale' })

    await started.close()
  })

  it('defaults its redirect URI to the current page', async () => {
    const started = await popupReceiver().start({ provider })
    expect(started.redirectUri).toBe('http://localhost/')

    await started.close()
  })
})

/**
 * A `postMessage` reaches one window, which is true and is not the same claim
 * as "reaches one receiver". Two sign-ins started at once — a double-clicked
 * button, or two provider buttons on one page — put two listeners on that same
 * opener, and the browser hands every message to both. The receiver that did
 * not open the popup then resolves with the other flow's callback, and the
 * client, holding the authoritative `state`, reports a double-click as
 * `state_mismatch … (possible CSRF)`.
 *
 * Two separate popups is the whole scenario; the window name plays no part in
 * it, since the flows here settle from messages rather than from windows.
 */
describe('two popup sign-ins in flight at once', () => {
  it('delivers a callback only to the attempt whose state it carries', async () => {
    const first = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const second = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })

    await first.present('https://provider.test/authorize?state=one')
    await second.present('https://provider.test/authorize?state=two')

    const watchedFirst = watch(first)

    // The second popup finishes. Both listeners hear it.
    deliverCallback('?code=c2&state=two')
    await delivered()

    await expect(second.wait()).resolves.toEqual({ code: 'c2', state: 'two' })
    expect(watchedFirst.settled).toBe(false)

    // And the first attempt is still live rather than poisoned, so its own
    // callback still completes it.
    deliverCallback('?code=c1&state=one')
    await expect(first.wait()).resolves.toEqual({ code: 'c1', state: 'one' })

    await first.close()
    await second.close()
  })

  it('does not fail one attempt on the other’s denial', async () => {
    const first = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const second = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })

    await first.present('https://provider.test/authorize?state=one')
    await second.present('https://provider.test/authorize?state=two')

    const watchedFirst = watch(first)

    deliverCallback('?error=access_denied&error_description=nope&state=two')
    await delivered()

    await expect(second.wait()).rejects.toMatchObject({ code: 'authorization_denied' })
    expect(watchedFirst.settled).toBe(false)

    await first.close()
    await second.close()
  })

  /**
   * The exemption the broadcast path already makes, kept identical here: a
   * provider that echoes no `state` leaves nothing to tell two attempts apart,
   * and refusing the callback on that basis would refuse the only callback such
   * a provider can produce. Both attempts take it, which is the documented cost
   * of `echoesState: false` rather than a gap in this filter.
   */
  it('still hands a callback to both when the provider echoes no state', async () => {
    const unechoing = defineProvider({ ...provider, id: 'unechoing', echoesState: false })
    const first = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: unechoing,
    })
    const second = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: unechoing,
    })

    await first.present('https://provider.test/authorize?state=one')
    await second.present('https://provider.test/authorize?state=two')

    deliverCallback('?code=whoever')

    await expect(first.wait()).resolves.toEqual({ code: 'whoever' })
    await expect(second.wait()).resolves.toEqual({ code: 'whoever' })

    await first.close()
    await second.close()
  })

  /**
   * A finished sign-in stops counting. Otherwise the next lone login on the
   * page would go on comparing `state` on the opener path, and a mismatch there
   * — which is meant to reach the client and fail loudly as `state_mismatch` —
   * would start hanging until the timeout instead.
   */
  it('leaves the next lone sign-in taking its callback as it comes', async () => {
    const first = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const second = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })

    await first.present('https://provider.test/authorize?state=one')
    await second.present('https://provider.test/authorize?state=two')
    await first.close()
    await second.close()

    const lone = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = lone.wait()
    await lone.present('https://provider.test/authorize?state=mine')

    // A `state` that does not match, handed over anyway, because with one
    // receiver on the window there is no second attempt it could have been
    // meant for and the client is the better judge of it.
    deliverCallback('?code=abc&state=stale')

    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'stale' })

    await lone.close()
  })
})

/**
 * A page served with `Cross-Origin-Opener-Policy: same-origin` — the standard
 * hardening header — swaps the browsing-context group on the popup's first
 * cross-origin navigation, whatever provider that is, because the popup's
 * initial `about:blank` inherits the opener's COOP and no ordinary
 * authorization page matches it. The opener's handle is disowned and reports
 * `closed === true` for a window the user is still typing into, so the poll
 * rejects every popup sign-in as abandoned.
 *
 * jsdom implements no COOP, so what these pin is the receiver's reaction to
 * being told: a `pollForClose: false` receiver must not reject on a handle that
 * claims to be closed, and must still complete from the message it goes on to
 * receive.
 */
describe('popupReceiver with the close-poll turned off', () => {
  it('does not fail the login when the handle reports closed from the start', async () => {
    popup.closed = true
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 5,
      pollForClose: false,
    }).start({ provider })
    const watched = watch(started)
    await started.present('https://provider.test/authorize?state=mine')

    // Several poll intervals, were the poll running at all.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(watched.settled).toBe(false)

    deliverCallback('?code=abc&state=mine')
    await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'mine' })

    await started.close()
  })

  /**
   * The obvious fix — reading `popup.closed` once, straight after
   * `window.open`, and skipping the poll if it is already true — cannot work,
   * and this is why: the group swap happens when the popup commits its first
   * cross-origin navigation, not when it opens, so the handle reads `false` at
   * open time and flips underneath the poll a moment later. A receiver that
   * has been told may not depend on the state of the handle at any particular
   * moment.
   */
  it('honours the option even when the handle only starts lying later', async () => {
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 5,
      pollForClose: false,
    }).start({ provider })
    const watched = watch(started)
    await started.present('https://provider.test/authorize?state=mine')

    // Open, honest, and only then disowned — the order a real COOP swap
    // happens in.
    expect(popup.closed).toBe(false)
    popup.closed = true

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(watched.settled).toBe(false)

    deliverCallback('?code=abc&state=mine')
    await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'mine' })

    await started.close()
  })

  it('polls by default, and when told to explicitly', async () => {
    // The option only ever removes the poll; nothing about the default moves.
    for (const options of [{}, { pollForClose: true }]) {
      const started = await popupReceiver({
        redirectUri: 'http://localhost/callback',
        pollIntervalMs: 5,
        ...options,
      }).start({ provider })
      const waiting = started.wait()
      await started.present('https://provider.test/authorize')

      popup.closed = true
      await expect(waiting).rejects.toMatchObject({ code: 'aborted' })

      await started.close()
      popup.closed = false
    }
  })
})

describe('popupReceiver against a provider that severs the opener', () => {
  it('completes from the channel alone, with no opener involved', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    const waiting = started.wait()
    await started.present('https://severe.test/authorize')

    const delivered = announceCallback('?code=abc&state=xyz')

    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'xyz' })
    await expect(delivered).resolves.toBe(true)

    await started.close()
  })

  /**
   * The regression that shipped. A handle severed by COOP reports `closed`
   * as `true` from the moment the popup opens, and the close-poll must not
   * treat that as the user giving up — the fix is to not run the poll at all
   * for a provider that severs the opener, not to make the poll smarter.
   */
  it('does not fail the login when the handle reports closed from the start', async () => {
    popup.closed = true
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 10,
    }).start({ provider: severingProvider })
    const waiting = started.wait()
    await started.present('https://severe.test/authorize')

    // Long enough for several poll intervals to have fired, were the poll running.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const delivered = announceCallback('?code=late&state=xyz')

    await expect(waiting).resolves.toEqual({ code: 'late', state: 'xyz' })
    await expect(delivered).resolves.toBe(true)

    await started.close()
  })

  it('surfaces a provider denial arriving over the channel', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    const waiting = started.wait()
    await started.present('https://severe.test/authorize')

    announceCallback('?error=access_denied&error_description=nope')

    await expect(waiting).rejects.toMatchObject({
      code: 'authorization_denied',
      providerError: 'access_denied',
    })

    await started.close()
  })

  it('still rejects on an aborted signal, despite the lying handle', async () => {
    popup.closed = true
    const controller = new AbortController()
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 5,
    }).start({ provider: severingProvider, signal: controller.signal })
    const waiting = started.wait()
    await started.present('https://severe.test/authorize')

    // Several poll intervals before the abort, and the message rather than the
    // code: a close-poll that ran here would reject with `code: 'aborted'` too,
    // and nothing but the wording would tell the two apart.
    await new Promise((resolve) => setTimeout(resolve, 40))
    controller.abort()

    await expect(waiting).rejects.toThrow('Login was aborted.')

    await started.close()
  })

  /**
   * The premise of this whole path is a handle that reports `closed === true`
   * for a window still on screen, so a guard reading `closed` before calling
   * `close()` never fires for the one provider it was written for, and a
   * finished sign-in leaves its popup up.
   */
  it('closes a popup whose handle claims it is already closed', async () => {
    popup.closed = true
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://severe.test/authorize')
    await started.close()

    expect(popup.close).toHaveBeenCalled()
  })
})

describe('announceCallback', () => {
  it('resolves true once a waiting receiver acknowledges', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://severe.test/authorize')

    await expect(announceCallback('?code=abc&state=xyz')).resolves.toBe(true)
    await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'xyz' })

    await started.close()
  })

  it('resolves false when nothing is listening', async () => {
    // Someone reached the callback URL directly, with no popup waiting on it.
    await expect(announceCallback('?code=nobody-home', 20)).resolves.toBe(false)
  })

  /**
   * The opener's handle to a severed popup reports it closed already, and the
   * browser may decline to close a window on that handle at all, so the page
   * closing itself is what clears a finished sign-in off the screen.
   */
  it('closes its own window once a receiver acknowledges', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://severe.test/authorize')

    await expect(announceCallback('?code=abc&state=xyz')).resolves.toBe(true)
    expect(closeSpy).toHaveBeenCalled()

    await started.close()
  })

  it('leaves the window open when nothing acknowledges', async () => {
    // Whoever opened the redirect URL by hand is reading this page, not a
    // popup to be swept away.
    await expect(announceCallback('?code=nobody-home', 20)).resolves.toBe(false)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  /**
   * A `BroadcastChannel` carries acknowledgements as widely as it carries
   * announcements. One receiver confirming its own callback therefore also
   * reaches an unrelated `announceCallback` running in another tab, and an
   * announcement that accepts any acknowledgement at all would take it —
   * reporting a delivery that never happened, resolving `true`, and closing a
   * window whose code nobody has. The shipped consumer of that boolean is the
   * CDN example's callback page, which would skip its "not opened by a sign-in
   * popup" message and sit on "Signing you in…" indefinitely.
   */
  it('ignores an acknowledgement meant for a different announcement', async () => {
    // A `state` no receiver in this file ever presents, so the only thing that
    // could settle this announcement is the stray acknowledgement itself.
    const announced = announceCallback('?code=orphan&state=orphan-attempt', 60)
    const watched = { settled: false }
    announced.then(() => (watched.settled = true))

    acknowledgeSomeoneElse()
    await delivered()

    expect(watched.settled).toBe(false)
    expect(closeSpy).not.toHaveBeenCalled()

    // And it goes on to time out honestly, which is what tells a page nobody
    // was waiting on that it was opened by hand.
    await expect(announced).resolves.toBe(false)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  /**
   * The tolerance that makes the id safe to introduce at all. The redirect page
   * loads the SDK on its own — commonly from a CDN, commonly pinned elsewhere —
   * so an announcer on this version has to keep accepting the id-less
   * acknowledgement an older receiver sends. Refusing it would strand sign-ins
   * that in fact completed, which is a worse failure than the one the id fixes.
   */
  it('still accepts an acknowledgement from a receiver too old to echo an id', async () => {
    const announced = announceCallback('?code=mine&state=mine', 200)

    acknowledgeWithoutId()

    await expect(announced).resolves.toBe(true)
  })

  it('accepts the acknowledgement a current receiver sends back', async () => {
    // The end-to-end pairing, to pin that the receiver echoes what it was sent
    // rather than the two halves merely tolerating each other.
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://severe.test/authorize?state=xyz')

    await expect(announceCallback('?code=abc&state=xyz')).resolves.toBe(true)

    await started.close()
  })
})

describe('postCallbackToOpener', () => {
  afterEach(() => {
    Object.defineProperty(window, 'opener', { value: null, configurable: true })
  })

  it('posts to the opener and reports success', () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'opener', { value: { postMessage }, configurable: true })
    vi.spyOn(window, 'close').mockImplementation(() => {})

    expect(postCallbackToOpener('?code=abc&state=xyz')).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'aioauth:callback', payload: '?code=abc&state=xyz' },
      window.location.origin,
    )
  })

  it('returns false when the page has no opener', () => {
    // Someone navigated to the callback page directly.
    expect(postCallbackToOpener('?code=abc')).toBe(false)
  })

  it('targets its own origin, never a wildcard', () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'opener', { value: { postMessage }, configurable: true })
    vi.spyOn(window, 'close').mockImplementation(() => {})

    postCallbackToOpener('?code=abc')
    // A '*' target would leak the authorization code to any listener.
    expect(postMessage.mock.calls[0]?.[1]).toBe(window.location.origin)
    expect(postMessage.mock.calls[0]?.[1]).not.toBe('*')
  })
})

/**
 * A `BroadcastChannel` reaches every context on the origin, where the
 * `postMessage` path could only ever reach the window that opened the popup.
 * That difference is what makes these necessary: two tabs of the same app,
 * each mid-sign-in, would otherwise have whichever receiver heard the
 * broadcast first consume a callback minted for the other.
 *
 * The client's own `state` comparison would reject a stolen callback, so
 * nothing here is what stops a forged code getting in. What it stops is two
 * working sign-ins becoming one failure.
 */
describe('a callback broadcast while another attempt is open', () => {
  it('is ignored by a receiver whose attempt carries a different state', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://provider.test/authorize?state=mine')

    const watched = watch(started)

    broadcastCallback('?code=not-mine&state=another-tab')
    await delivered()

    expect(watched.settled).toBe(false)

    broadcastCallback('?code=mine&state=mine')
    await expect(started.wait()).resolves.toEqual({ code: 'mine', state: 'mine' })
  })

  /**
   * The rejection has to reach the attempt it belongs to and no other. A
   * receiver that parsed before deciding ownership would fail its own healthy
   * sign-in on a different tab's refusal.
   */
  it('does not fail this attempt on another attempt’s access_denied', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://provider.test/authorize?state=mine')

    const watched = watch(started)

    broadcastCallback('?error=access_denied&state=another-tab')
    await delivered()

    expect(watched.settled).toBe(false)

    broadcastCallback('?code=mine&state=mine')
    await expect(started.wait()).resolves.toEqual({ code: 'mine', state: 'mine' })
  })

  /**
   * `client.login()` awaits `createAuthorization()` — real storage I/O —
   * between `start()` and `present()`. A receiver listening in that window has
   * no attempt of its own yet, and taking a callback there both drops another
   * tab's sign-in and tells that tab it was delivered.
   */
  it('is ignored, and left unacknowledged, before present() has run', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    const watched = watch(started)

    await expect(announceCallback('?code=another-tab&state=another-tab', 20)).resolves.toBe(false)
    expect(watched.settled).toBe(false)

    await started.present('https://provider.test/authorize?state=mine')
    broadcastCallback('?code=mine&state=mine')

    await expect(started.wait()).resolves.toEqual({ code: 'mine', state: 'mine' })
  })

  /**
   * Nothing to compare is not a mismatch. An authorization URL with no
   * readable `state`, or a provider that does not echo one, leaves the
   * receiver taking the callback exactly as it did before any of this.
   */
  it('still takes a callback when there is no state to compare', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://provider.test/authorize')

    broadcastCallback('?code=unstated&state=whatever')

    await expect(started.wait()).resolves.toEqual({ code: 'unstated', state: 'whatever' })
  })

  /**
   * `echoesState: false` is that same "nothing to compare", declared ahead of
   * time rather than discovered. `buildAuthorizationUrl` puts a `state` on
   * every URL it builds, so unless a provider strips it in `buildAuthParams`
   * the way OpenRouter does, one is presented to a provider that has already
   * said it will not send it back. Holding the callback to a comparison the
   * provider cannot satisfy would reject the only callback it can produce, and
   * the login would hang to its timeout instead of completing.
   */
  it('still takes a callback from a provider that declares it echoes no state', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: defineProvider({ ...severingProvider, echoesState: false }),
    })
    await started.present('https://provider.test/authorize?state=presented')

    broadcastCallback('?code=unechoed')

    await expect(started.wait()).resolves.toEqual({ code: 'unechoed' })
  })

  /**
   * The other direction of the same comparison, and the one that bites: a
   * payload with no `state` cannot be shown to belong to an attempt that
   * presented one. The redirect page announces whatever query string it was
   * loaded with, so anything that can get this origin's redirect page opened —
   * a cross-origin link to `?error=access_denied` is enough — could otherwise
   * broadcast a state-less denial that rejects a live login on the spot, well
   * before the client has any chance to compare `state` itself.
   */
  it('is ignored when it carries no state and this attempt presented one', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://provider.test/authorize?state=mine')

    const watched = watch(started)

    broadcastCallback('?error=access_denied&error_description=nope')
    await delivered()

    expect(watched.settled).toBe(false)

    // And the genuine callback still lands afterwards: the attempt was left
    // waiting, not quietly poisoned.
    broadcastCallback('?code=mine&state=mine')
    await expect(started.wait()).resolves.toEqual({ code: 'mine', state: 'mine' })
  })

  /**
   * No attacker required. Where the app's own root is its redirect page —
   * which is what `autoReceiver` arranges on a loopback origin — opening a
   * second tab of the app runs the redirect page with an empty query, and it
   * announces `''`. That parses to a state-less "no code returned", and taking
   * one would have a stray tab kill a sign-in running in another.
   */
  it('is ignored when a second tab broadcasts an empty payload', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://provider.test/authorize?state=mine')

    const watched = watch(started)

    broadcastCallback('')
    await delivered()

    expect(watched.settled).toBe(false)

    broadcastCallback('?code=mine&state=mine')
    await expect(started.wait()).resolves.toEqual({ code: 'mine', state: 'mine' })
  })

  /**
   * A fragment is not part of the query, and reading one as though it were
   * yields a `state` that matches nothing — the receiver then drops a callback
   * the client would have taken, and the login hangs instead of failing.
   */
  it('is not confused by a fragment on the authorization URL', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: severingProvider,
    })
    await started.present('https://provider.test/authorize?state=mine#section')

    broadcastCallback('?code=mine&state=mine')

    await expect(started.wait()).resolves.toEqual({ code: 'mine', state: 'mine' })
  })
})

/**
 * The provider the whole severed-opener path exists for, paired with the
 * receiver rather than stood in for. Claude answers a bare `CODE#STATE` string
 * rather than query params, which only `parseClaudeCallback` reads — anything
 * else sees one opaque token, finds no `state` in it, and matches every
 * callback to every attempt.
 */
describe('popupReceiver against the real claude descriptor', () => {
  it('tells one attempt’s CODE#STATE from another’s', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider: claude,
    })
    await started.present('https://claude.ai/oauth/authorize?client_id=cid&state=mine&code=true')

    const watched = watch(started)

    broadcastCallback('another-code#another-tab')
    await delivered()

    expect(watched.settled).toBe(false)

    broadcastCallback('my-code#mine')
    await expect(started.wait()).resolves.toEqual({ code: 'my-code', state: 'mine' })

    await started.close()
  })

  it('skips the close-poll, since the descriptor says the handle lies', async () => {
    popup.closed = true
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 5,
    }).start({ provider: claude })
    const watched = watch(started)
    await started.present('https://claude.ai/oauth/authorize?client_id=cid&state=mine&code=true')

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(watched.settled).toBe(false)

    broadcastCallback('my-code#mine')
    await expect(started.wait()).resolves.toEqual({ code: 'my-code', state: 'mine' })

    await started.close()
  })
})
