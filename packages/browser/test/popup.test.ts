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
   * so there is no second attempt it could have been meant for and nothing for
   * the receiver to rule on. An app passing `window.location.href` rather than
   * the default `window.location.search`, against a provider that appends a
   * fragment, produces exactly the payload a `state` filter here would drop —
   * and the client, which has the authoritative `state`, would rather be told.
   */
  it('hands a postMessage callback through whatever its state looks like', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider,
    })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize?state=mine')

    deliverCallback('https://app.test/callback?code=abc&state=mine#_=_')

    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'mine#_=_' })

    await started.close()
  })

  it('defaults its redirect URI to the current page', async () => {
    const started = await popupReceiver().start({ provider })
    expect(started.redirectUri).toBe('http://localhost/')

    await started.close()
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
