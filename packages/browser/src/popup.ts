import {
  OAuthError,
  hasSecureRandom,
  isOAuthError,
  readCallback,
  type CallbackReceiver,
  type CallbackResult,
  type ReceiverContext,
} from '@ai-oauth-sdk/core'

export interface PopupReceiverOptions {
  /**
   * Redirect URI — a page on your origin that runs {@link postCallbackToOpener}
   * and falls back to {@link announceCallback}.
   */
  redirectUri?: string
  width?: number
  height?: number
  /**
   * Popup window name. Defaults to an unpredictable per-attempt name.
   *
   * A *fixed* name is a name anyone can guess, and a named auxiliary window can
   * be reached by name from anywhere in its browsing context group — so a page
   * the user reached this app from can navigate the live popup mid-flow. Pass
   * one only if something genuinely has to address the window (a test harness),
   * and never a constant in a page an outsider can open.
   */
  windowName?: string
  /** How often to check whether the user closed the popup. Default 400ms. */
  pollIntervalMs?: number
}

const MESSAGE_TYPE = 'aioauth:callback'

/**
 * Where the redirect page announces a callback for a receiver that cannot
 * trust `window.opener`. A `BroadcastChannel` is same-origin by construction —
 * a page on another origin cannot open one under this name and receive
 * anything — so the code stays on the origin that started the sign-in, as it
 * does with `postMessage`'s explicit target origin.
 *
 * The audience is wider, though, and that is the difference that matters here:
 * `postMessage` reaches one window, where a broadcast reaches every same-origin
 * context listening, other tabs and iframes of your own app included. Hence the
 * `state` comparison in {@link popupReceiver}.
 */
const CALLBACK_CHANNEL = 'aioauth:callback-channel'

/**
 * An unguessable name for the popup, minted per attempt.
 *
 * The `state` comparison below is what refuses a hijacked popup's payload, but
 * it cannot be the whole answer: a provider declaring `echoesState: false` has
 * said no `state` will come back, so the comparison is exempt for exactly the
 * provider the browser popup flow most often serves. Taking the name out of the
 * published source removes the precondition instead of the consequence — a
 * window nobody can name is a window nobody can navigate by name.
 *
 * This throws rather than falling back, the way the rest of the library does
 * with randomness. Neither available alternative is acceptable: `Math.random()`
 * would only look unguessable, and returning the old constant would silently
 * restore the precondition — for the `echoesState: false` provider, the *only*
 * protection there is — at the one moment we have learned we cannot provide it.
 *
 * Nor is the throw unreachable in the way it might appear. The client mints
 * PKCE through its own `crypto` option, and `createDefaultCrypto` tells a
 * caller on a runtime without `getRandomValues` to supply one; a caller who
 * does gets a working `createAuthorization()` and arrives here regardless.
 * `ReceiverContext` does not carry that adapter, so this cannot borrow it. In a
 * browser the question is close to moot — `getRandomValues` is exposed on
 * insecure origins too, only `subtle` is gated — which is what makes refusing
 * cheap and silence expensive.
 */
function popupWindowName(): string {
  if (!hasSecureRandom()) {
    throw new OAuthError(
      'unsupported_runtime',
      'popupReceiver needs crypto.getRandomValues to name the popup unpredictably, and this ' +
        'runtime has none. A fixed name lets a page that can reach this one navigate the popup ' +
        'mid-flow. Pass an explicit `windowName` only if you have another way to prevent that.',
    )
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))

  return `aioauth-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

type ChannelMessage = { kind: 'callback'; payload: string } | { kind: 'received' }

/**
 * The `state` in an authorization URL, or nothing where it carries none.
 *
 * This reads the URL the client built and handed over to present, never a
 * callback: its params are in the query, so a fragment is something else and
 * is left out of the read — `URLSearchParams` would otherwise carry it into
 * the value and produce a `state` that matches nothing. Callbacks go through
 * the provider's own parser instead, which is the only thing that knows where
 * a given provider puts them.
 */
function stateOfAuthorizationUrl(url: string): string | undefined {
  const questionMark = url.indexOf('?')

  if (questionMark === -1) {
    return undefined
  }

  const query = url.slice(questionMark + 1).split('#')[0]!

  return new URLSearchParams(query).get('state') ?? undefined
}

/**
 * Receives the callback in a popup window.
 *
 * Keeps the host page alive — no navigation, no state to rehydrate — which
 * makes it the nicest option for an SPA. Your redirect page must call
 * {@link postCallbackToOpener}, falling back to {@link announceCallback} when
 * it returns `false`; the popup is same-origin with the opener at that point,
 * so `postCallbackToOpener` can hand the code back over `postMessage`.
 * Messages from any other origin are ignored — by the time the popup posts it
 * is same-origin, so anything else is not ours.
 *
 * `claude.ai` answers with an enforced `Cross-Origin-Opener-Policy:
 * same-origin`, which moves a popup opened to it into its own
 * browsing-context group: `window.opener` inside the popup is `null` from
 * then on, permanently, even once it navigates back to the redirect page on
 * our own origin, and the opener's handle to the popup reports `closed ===
 * true` while the popup is still open. `postMessage` therefore never arrives
 * for such a provider, and polling `.closed` would fail the sign-in within one
 * interval of the popup opening rather than notice the user closing it. This
 * receiver reads `context.provider.authPage?.seversOpener` to skip the poll
 * for such a provider, and relies on the `BroadcastChannel` path — which does
 * not go through the opener relationship — to complete the login instead.
 *
 * Nothing replaces that poll, so for such a provider a user who opens the
 * popup and changes their mind leaves `wait()` pending: the handle reports
 * nothing usable, and a popup the user closed never announces anything. Give
 * `login()` a `timeoutMs` or a `signal` there, or the promise waits as long as
 * the page lives.
 *
 * A callback heard on the `BroadcastChannel` is matched to this attempt by
 * `state`, because that channel reaches every context on the origin. A
 * provider that does not echo `state` (OpenRouter) leaves nothing to match on,
 * so two sign-ins against one of those, running at once in two tabs, can still
 * take each other's callbacks.
 *
 * The `window` guard runs before anything touches `window`, or it would never
 * run at all: deriving the default `redirectUri` first would throw a bare
 * `ReferenceError`.
 */
export function popupReceiver(options: PopupReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'popup',
    async start(context: ReceiverContext) {
      if (typeof window === 'undefined') {
        throw new OAuthError('unsupported_runtime', 'popupReceiver requires a browser window.')
      }

      const redirectUri = options.redirectUri ?? window.location.href.split('#')[0]!
      const seversOpener = context.provider.authPage?.seversOpener === true

      let popup: Window | null = null
      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })
      callbackPromise.catch(() => {})

      let closedPoller: ReturnType<typeof setInterval> | undefined

      /**
       * The `state` of the authorization this receiver actually presented,
       * learned from the URL it was handed rather than tracked separately, so
       * the two cannot disagree.
       */
      let presentedState: string | undefined

      /**
       * Whether `present()` has run.
       *
       * `start()` and `present()` are separated by the client's
       * `createAuthorization()`, which does real storage I/O. Until the second
       * one runs this receiver has no attempt of its own, so it has nothing to
       * compare a broadcast against and must not take one: it would consume,
       * and acknowledge, a callback minted by another tab.
       */
      let presented = false

      /**
       * The provider's own read of a payload, with the failure it may
       * represent held rather than thrown.
       *
       * The `state` has to come from the same parser the client will use.
       * Providers disagree about where the callback params live — Claude
       * answers a bare `CODE#STATE`, others carry the pair in a fragment — and
       * `parseCallback` is the only thing that knows which. Reading it any
       * other way drops callbacks the client would have taken, and a dropped
       * callback is a login that hangs rather than one that fails.
       *
       * Settling is held back so ownership can be decided first: `readCallback`
       * throws on an `error=` callback, and that rejection has to reach the
       * attempt it belongs to and no other.
       */
      const read = (payload: string): { state: string | undefined; settle: () => void } => {
        try {
          const result = readCallback(context.provider, payload)

          return { state: result.state, settle: () => resolveCallback(result) }
        } catch (error) {
          // An `error=` payload is the one shape `parseCallback` refuses, and
          // `readCallback` carries the `state` its parse found onto the error
          // it throws — so even a refusal still says whose it is.
          return {
            state: isOAuthError(error) ? error.state : undefined,
            settle: () => rejectCallback(error),
          }
        }
      }

      /**
       * Whether a broadcast callback belongs to *this* receiver's attempt.
       *
       * Two tabs of the same app, each mid-sign-in, would otherwise have every
       * receiver on the origin take every callback. The client's own `state`
       * comparison would reject the one that got the wrong callback, so this
       * is not what stops a forged code getting in — what it stops is two
       * working sign-ins becoming one failure.
       *
       * A callback carrying no `state` is refused wherever this attempt
       * presented one, and that asymmetry is the point rather than an
       * oversight. A payload with no `state` cannot be shown to be ours, and
       * it is exactly what a stray or hostile broadcast looks like: the
       * redirect page announces whatever query string it happens to be loaded
       * with, so anything that can get this origin's redirect page opened —
       * a second tab of an app whose root *is* its redirect page, or a
       * cross-origin link to `?error=access_denied` — puts a state-less
       * payload on the channel. Taking one would let it cancel a live login
       * outright, because a payload that reads as a denial rejects `wait()`
       * here, and the client's own `state` comparison never runs on a
       * receiver that threw.
       *
       * Nothing to compare is still not a mismatch, the other way round: an
       * authorization URL that carried no `state` leaves this receiver with no
       * attempt to tell callbacks apart by, and one is taken as it comes.
       *
       * A provider declaring `echoesState: false` is that same case even though
       * the authorization URL carried a `state`, because it is a statement that
       * the callback will not bring one back. Sending a `state` and refusing
       * every callback for not returning it would reject the only callback such
       * a provider can produce. The client makes the same exception at the same
       * boundary, and `SECURITY.md` is plain about what it costs: these
       * providers resolve against the most recently started flow, which is fine
       * for a CLI or a single-flow app and is not safe in a multi-user server.
       */
      /**
       * A trailing fragment artifact is not a different attempt.
       *
       * Some providers append one — `#_=_` is the well-known case — and an app
       * that hands the receiver `window.location.href` rather than its search
       * string carries it into the parsed value, so `mine` arrives as
       * `mine#_=_`. Be plain about what tolerating it buys, because it is less
       * than it looks: such a callback still fails. The client compares the
       * state exactly, with no stripping, and rejects it as `state_mismatch`.
       * What changes is only *how* it fails — at the client, immediately and by
       * name, rather than here, silently, as a login that hangs to its timeout.
       * A legible error on a misconfigured app is worth the wider accept
       * surface; a working configuration is not on offer either way.
       *
       * The surface stays narrow regardless. Matching still requires the
       * attempt's own 256-bit `state` as a prefix, which is what an outsider
       * cannot supply, and `presentedState` is base64url so it can never itself
       * contain a `#` for the split to cut short. What this test exists to
       * refuse is a payload that answers for no attempt at all.
       */
      const attemptState = (state: string | undefined): string | undefined => state?.split('#')[0]

      const belongsToThisAttempt = (state: string | undefined): boolean =>
        presentedState === undefined ||
        context.provider.echoesState === false ||
        attemptState(state) === presentedState

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return
        }

        const data = event.data as { type?: string; payload?: string } | null

        if (!data || data.type !== MESSAGE_TYPE || typeof data.payload !== 'string') {
          return
        }

        /* Matched to the attempt on the same test the channel below applies,
           and for the same reason. A `postMessage` does reach only the window
           that opened the popup — but "the window we opened" is not the same
           claim as "a window only we can reach". A named auxiliary window is
           findable by name from anywhere in its browsing context group, and
           the opener chain keeps a page the user arrived from inside that
           group: it can call `window.open(ourRedirectPage, windowName)` and
           navigate the live popup, which then posts to us from our own origin
           with our own handle. `event.source` cannot tell that apart — a
           `WindowProxy` keeps its identity across navigation, so the hijacked
           popup is still `popup` — and the origin check passes by
           construction. `state` is the only thing the outsider cannot supply.

           The shape that matters is a payload carrying none: an unsolicited
           `?error=access_denied` rejects `wait()` before the client's own
           comparison can run, cancelling a live sign-in on demand. That is
           the same drive-by the loopback receiver and the channel handler
           already refuse. */
        const callback = read(data.payload)

        if (!presented || !belongsToThisAttempt(callback.state)) {
          return
        }

        callback.settle()
      }

      window.addEventListener('message', onMessage)

      // Opened for every provider, not only one that severs the opener: a
      // redirect page falls back to `announceCallback` whenever
      // `postCallbackToOpener` reports no opener, whatever the reason, and a
      // callback that arrives twice is cheaper to ignore than one that never
      // arrives at all.
      const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(CALLBACK_CHANNEL)

      if (channel) {
        channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
          if (!presented || event.data?.kind !== 'callback') {
            return
          }

          const callback = read(event.data.payload)

          if (!belongsToThisAttempt(callback.state)) {
            return
          }

          callback.settle()
          // Acknowledged only by the attempt the callback belongs to. A
          // receiver that acknowledged another tab's callback would tell that
          // page it had been delivered while dropping it, and the tab that
          // was actually waiting for it would wait forever.
          channel.postMessage({ kind: 'received' } satisfies ChannelMessage)
        }
      }

      /**
       * Closing is unconditional. A handle severed by COOP reports `closed ===
       * true` for a window still on screen, so testing `closed` first would
       * skip the close for precisely the provider that needs it. `close()` on
       * a window already gone does nothing, and the login has settled by the
       * time this runs, so a window the browser declines to close is not a
       * failed sign-in — it is why {@link announceCallback} has the redirect
       * page close itself as well.
       */
      const closePopup = () => {
        try {
          popup?.close()
        } catch {
          // The login has already settled; there is nothing left to fail.
        }
      }

      const cleanup = () => {
        window.removeEventListener('message', onMessage)
        channel?.close()

        if (closedPoller) {
          clearInterval(closedPoller)
        }

        context.signal?.removeEventListener('abort', onAbort)
      }

      const onAbort = () => {
        rejectCallback(new OAuthError('aborted', 'Login was aborted.'))
        closePopup()
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri,
        async present(url) {
          // Read from the URL the client built rather than tracked alongside
          // it, so what this receiver believes its attempt is can never drift
          // from what it actually sent the user to.
          presentedState = stateOfAuthorizationUrl(url)
          presented = true

          const width = options.width ?? 520
          const height = options.height ?? 680
          const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2)
          const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2)

          popup = window.open(
            url,
            options.windowName ?? popupWindowName(),
            `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
          )

          if (!popup) {
            cleanup()
            throw new OAuthError(
              'unsupported_runtime',
              'The popup was blocked. Call login() directly from a user gesture ' +
                '(click handler), or use redirectReceiver() instead.',
            )
          }

          // Skipped for a provider that severs the opener: the handle above
          // already reports `closed === true` for a window still on screen,
          // so polling it would fail the sign-in instead of detecting the
          // user giving up. Where the opener stays intact this is the only
          // signal a closed window leaves behind, so it still runs there.
          if (!seversOpener) {
            closedPoller = setInterval(() => {
              if (popup?.closed) {
                clearInterval(closedPoller)
                rejectCallback(
                  new OAuthError('aborted', 'The sign-in window was closed before completing.'),
                )
              }
            }, options.pollIntervalMs ?? 400)
          }
        },
        wait: () => callbackPromise,
        async close() {
          cleanup()
          closePopup()
        },
      }
    },
  }
}

/**
 * Call this on your redirect page to hand the callback back to the opener.
 *
 * Returns `false` without a way to distinguish its two causes: someone
 * reached the redirect page directly, with no popup to speak of, or the
 * provider's authorization page severed `window.opener` (`claude.ai` does
 * this — see {@link popupReceiver}), leaving a popup that is still there but
 * unreachable this way. Fall back to {@link announceCallback}, which is built
 * to tell those two apart:
 *
 * ```html
 * <script type="module">
 *   import { postCallbackToOpener, announceCallback } from 'https://esm.sh/@ai-oauth-sdk/browser'
 *   if (!postCallbackToOpener()) {
 *     await announceCallback()
 *   }
 * </script>
 * ```
 */
export function postCallbackToOpener(payload: string = window.location.search): boolean {
  if (!window.opener) {
    return false
  }

  window.opener.postMessage({ type: MESSAGE_TYPE, payload }, window.location.origin)
  window.close()

  return true
}

/**
 * Call this on your redirect page when {@link postCallbackToOpener} reports no
 * opener, to hand the callback to a popup waiting on the `BroadcastChannel`
 * instead — same-origin by construction, and untouched by a severed opener
 * because it never goes through `window.opener` at all.
 *
 * Resolves `true` once a waiting receiver acknowledges, and closes this window
 * on the way out, the way `postCallbackToOpener` does: the opener's own handle
 * to a severed popup may no longer be able to close it, so a popup that closes
 * itself is what keeps a finished sign-in from leaving a window on screen.
 *
 * Resolves `false` once `timeoutMs` passes with nothing acknowledging. That is
 * usually someone who opened the redirect URL directly, with nothing waiting
 * anywhere — the distinction being the whole reason this is async where
 * `postCallbackToOpener` is not, since a broadcast is otherwise
 * fire-and-forget. It is not proof of it, though: a receiver on a busy main
 * thread can miss the deadline for a callback it goes on to accept. Read it as
 * "say something, this window is on its own", not as "the code was lost".
 *
 * Degrades to an immediate `false` where `BroadcastChannel` does not exist,
 * so a caller can await it unconditionally.
 */
export function announceCallback(
  payload: string = window.location.search,
  timeoutMs = 1500,
): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    const channel = new BroadcastChannel(CALLBACK_CHANNEL)
    let settled = false

    const finish = (received: boolean) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      channel.close()
      resolve(received)

      if (received) {
        window.close()
      }
    }

    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      if (event.data?.kind === 'received') {
        finish(true)
      }
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    channel.postMessage({ kind: 'callback', payload } satisfies ChannelMessage)
  })
}
