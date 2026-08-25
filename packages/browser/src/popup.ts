import {
  OAuthError,
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
  /** Popup window name. */
  windowName?: string
  /** How often to check whether the user closed the popup. Default 400ms. */
  pollIntervalMs?: number
  /**
   * Whether to poll `popup.closed` to notice the user giving up. Default
   * `true`. Set it to `false` when your own page is served with
   * `Cross-Origin-Opener-Policy: same-origin`.
   *
   * That header — the standard hardening one, and a prerequisite for
   * `crossOriginIsolated` — severs the opener from *your* side rather than the
   * provider's, and does it for every provider rather than the one or two whose
   * descriptors declare `authPage.seversOpener`. The popup's initial
   * `about:blank` inherits your COOP; the provider's page almost certainly
   * serves `unsafe-none`; the two do not match, so the browsing-context group
   * swaps on that first cross-origin navigation and your handle to the popup is
   * disowned. `popup.closed` then reads `true` for a window the user is still
   * typing their password into, and the poll rejects the sign-in as abandoned
   * within one interval. `same-origin-allow-popups` exists precisely to keep
   * the opener across a popup and does not do this; only `same-origin` does.
   *
   * It has to be told rather than detected. A page cannot read its own COOP,
   * and `crossOriginIsolated` answers `false` under `COOP: same-origin` without
   * a matching COEP, so there is nothing to test. Turning the poll off costs
   * only the ability to notice a closed window, the same trade a provider that
   * severs the opener already makes — pass `timeoutMs` or a `signal` to
   * `login()` so an abandoned sign-in still ends.
   */
  pollForClose?: boolean
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
 * An announcement and its acknowledgement, correlated by `id`.
 *
 * The `id` exists because the channel is a broadcast: an acknowledgement posted
 * for one announcement reaches every context on the origin, so a bare
 * `{ kind: 'received' }` also satisfies an unrelated {@link announceCallback}
 * that happens to be in flight in another tab. That tab would then report a
 * delivery that never happened and close itself, when what it should have done
 * is time out, resolve `false`, and tell whoever is reading it that nothing was
 * waiting for this page.
 *
 * It is not a security boundary and does not need to be unguessable. Anything
 * that can post on this channel is already same-origin and could simply
 * announce a callback of its own; the `id` only tells two honest announcements
 * apart.
 *
 * Both fields are optional so a mixed pair still works. The redirect page loads
 * this SDK independently of the app that opened it — often from a CDN, often
 * pinned to a different version — so an announcer on this version has to keep
 * accepting an acknowledgement from a receiver on an older one, which sends no
 * `id` at all. See {@link announceCallback} for how that tolerance is spelled.
 */
type ChannelMessage =
  | { kind: 'callback'; id?: string; payload: string }
  | { kind: 'received'; id?: string }

/**
 * Counter behind the announcement ids, so two announcements from the same page
 * — a second sign-in after a first — cannot collide on the random half alone.
 */
let announcementCounter = 0

/**
 * `Math.random` rather than `crypto.getRandomValues`, on purpose. This module
 * runs on the redirect page, which is often a bare HTML file loading the SDK
 * from a CDN, and `crypto` is unavailable there on any insecure origin — a
 * plain `http://` page on a LAN address, which is a real way people serve a dev
 * build. An id that is merely distinct costs nothing and works everywhere; the
 * id is not relied on to be unpredictable.
 */
function announcementId(): string {
  announcementCounter += 1

  return `${announcementCounter}-${Math.random().toString(36).slice(2)}`
}

/**
 * Every receiver currently listening on this window for a callback posted by
 * the popup.
 *
 * `postMessage` reaching exactly the window that opened the popup is what lets
 * a single receiver take a payload without judging it — but "one window" is not
 * "one receiver". Two sign-ins started at once, from a double-clicked button or
 * from two buttons on one page, attach two `message` listeners to the *same*
 * opener, and the browser delivers every message to both. The one that did not
 * open that popup then resolves with the other flow's callback, and the
 * client — which does hold the authoritative `state` — reports the result as
 * `state_mismatch … (possible CSRF)`, which is an alarming way to describe a
 * double-click.
 *
 * Membership is what tells the receiver whether that ambiguity exists at all,
 * so the `state` comparison can be confined to the case that needs it and the
 * lone-receiver case can go on taking payloads exactly as it always has. See
 * the message handler in {@link popupReceiver} for why that distinction is kept
 * rather than filtering unconditionally.
 */
const listeningReceivers = new Set<object>()

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
 * The same severing can come from the consumer's side instead, and that case
 * no descriptor can describe. A page served with `Cross-Origin-Opener-Policy:
 * same-origin` — the standard hardening header — makes the browsing-context
 * group swap on the popup's first cross-origin navigation whatever provider it
 * navigates to, because the popup's initial `about:blank` inherits the
 * opener's COOP and no ordinary authorization page matches it. Every popup
 * sign-in from such an app then rejects with `aborted` while the user is still
 * looking at the login form. Pass `pollForClose: false` there; it cannot be
 * detected, only declared.
 *
 * That failure is unusually hard to trace back, which is worth knowing before
 * dismissing the option as niche. `createAuthStore` in the core package
 * swallows an `aborted` rejection deliberately — a user closing the popup is
 * not an error worth showing — so in the React, Vue, Svelte and Solid bindings
 * this arrives as a button that stops spinning and says nothing at all.
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

      /**
       * This receiver's identity in {@link listeningReceivers}. An empty object
       * is enough: nothing reads it, and it only has to be distinct from every
       * other live receiver's so that two of them count as two.
       */
      const receiverToken = {}

      /**
       * Leaves the set of attempts still competing for a callback.
       *
       * Called the moment this attempt settles rather than waiting for
       * `close()`, because the set answers "could a payload arriving now have
       * been meant for someone else?" and an attempt holding its answer is no
       * longer one of the candidates. Settling first also means a caller that
       * forgets to `close()` — or one whose own `finally` never runs — cannot
       * leave a phantom competitor behind that has every later sign-in on the
       * page filtering its callbacks by `state` for no reason.
       */
      const stopCompeting = () => listeningReceivers.delete(receiverToken)

      let popup: Window | null = null
      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = (result) => {
          stopCompeting()
          resolve(result)
        }
        rejectCallback = (error) => {
          stopCompeting()
          reject(error)
        }
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
      const belongsToThisAttempt = (state: string | undefined): boolean =>
        presentedState === undefined ||
        context.provider.echoesState === false ||
        state === presentedState

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return
        }

        const data = event.data as { type?: string; payload?: string } | null

        if (!data || data.type !== MESSAGE_TYPE || typeof data.payload !== 'string') {
          return
        }

        const callback = read(data.payload)

        // With this receiver alone on the window, the payload is taken as it
        // comes and with no `state` of its own to answer for: a `postMessage`
        // reaches the window that opened the popup and nowhere else, so
        // whatever arrives here was minted for this attempt by construction,
        // and judging it again could only drop one the client is better placed
        // to rule on. That matters for a real case rather than a theoretical
        // one — an app handing `postCallbackToOpener` a whole
        // `window.location.href` against a provider that appends a fragment
        // produces a `state` this receiver reads as `mine#_=_`, and failing
        // loudly with `state_mismatch` beats hanging until the timeout.
        //
        // A second receiver listening on the same window is what breaks that
        // reasoning, because both of them then hear both popups' messages and
        // the wrong one settles first. Only there is the comparison worth its
        // cost, and it is the same predicate the broadcast path uses, so the
        // "nothing to compare" and `echoesState: false` exemptions behave
        // identically on both routes.
        if (listeningReceivers.size > 1 && !belongsToThisAttempt(callback.state)) {
          return
        }

        callback.settle()
      }

      window.addEventListener('message', onMessage)
      listeningReceivers.add(receiverToken)

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
          //
          // The announcement's own id is echoed back, so the acknowledgement
          // lands on the announcement it answers rather than on whichever one
          // is listening. An announcer that sent no id gets none back, which
          // is what an older announcer expects.
          channel.postMessage({
            kind: 'received',
            ...(event.data.id === undefined ? {} : { id: event.data.id }),
          } satisfies ChannelMessage)
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
        // Usually already gone, since settling drops it — this covers the
        // receiver closed without ever settling, which is what a `signal` or a
        // timeout on a login nobody completed leaves behind.
        stopCompeting()
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
            options.windowName ?? 'aioauth-login',
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
          //
          // Skipped as well when the caller has said their own page carries
          // `Cross-Origin-Opener-Policy: same-origin`, which produces the same
          // severed handle from the other side of the relationship and for
          // every provider rather than the declared ones — see
          // `pollForClose`. Checking `popup.closed` here, right after
          // `window.open`, would not catch that case and is not worth
          // attempting: the group swap happens when the popup commits its
          // first cross-origin navigation, which is after this line, so the
          // handle still reads `closed === false` at this point and would go
          // on to flip under the poll a moment later.
          if (!seversOpener && options.pollForClose !== false) {
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
    const id = announcementId()
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
      if (event.data?.kind !== 'received') {
        return
      }

      // An acknowledgement counts when it names this announcement, or when it
      // names none at all.
      //
      // The first is the point of the id: an acknowledgement reaches every
      // context on the origin, so without it a receiver in one tab confirming
      // its own callback would also satisfy an announcement running here for a
      // different one — this page would report a delivery that never happened
      // and close itself on a code nobody took.
      //
      // The second is required rather than lax. This page and the app that
      // opened it load the SDK separately, so a redirect page on a version that
      // sends an id can be answered by a receiver on a version that does not
      // know about ids and echoes nothing. Refusing that acknowledgement would
      // strand a sign-in that in fact completed, which is a far worse failure
      // than the one the id exists to prevent — so the older shape stays
      // acceptable, and the tightening only takes effect once both halves have
      // been upgraded.
      if (event.data.id !== undefined && event.data.id !== id) {
        return
      }

      finish(true)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    channel.postMessage({ kind: 'callback', id, payload } satisfies ChannelMessage)
  })
}
