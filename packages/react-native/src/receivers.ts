import {
  OAuthError,
  isOAuthError,
  parseQuery,
  readCallback,
  type CallbackReceiver,
  type CallbackResult,
  type ProviderConfig,
  type ReceiverContext,
} from '@ai-oauth-sdk/core'

import type { LinkingLike, WebBrowserLike } from './deps.js'

export interface DeepLinkReceiverOptions {
  /** `Linking` from `react-native`. */
  linking: LinkingLike
  /** Your app's callback URL, e.g. `myapp://auth/callback`. */
  redirectUri: string
}

/**
 * Everything in a URL before its query and its fragment.
 *
 * Used to decide whether a deep link is the callback at all. Comparing whole
 * paths rather than testing a prefix, because `myapp://auth/callbackXYZ`
 * starts with `myapp://auth/callback` and is a different screen.
 */
function pathOfUrl(url: string): string {
  return url.split('#')[0]!.split('?')[0]!
}

/**
 * The `state` in an authorization URL, or nothing where it carries none.
 *
 * This reads the URL the client built and handed to `present()`, never a
 * callback: its params are in the query, so a fragment is something else and is
 * left out of the read, which would otherwise be carried into the value and
 * produce a `state` that matches nothing. Callbacks go through the provider's
 * own parser instead, which is the only thing that knows where a given provider
 * puts them.
 *
 * `parseQuery` rather than `URLSearchParams`, which bare React Native does not
 * reliably have — the reason core carries its own query handling at all.
 */
function stateOfAuthorizationUrl(url: string): string | undefined {
  const questionMark = url.indexOf('?')

  if (questionMark === -1) {
    return undefined
  }

  return parseQuery(url.slice(questionMark + 1).split('#')[0]!)['state']
}

/**
 * A callback URL read by the provider's own parser, with the `state` it carries
 * separated from the outcome it represents.
 *
 * The `state` has to come from the same parser the client will use: providers
 * disagree about where the callback params live, and `parseCallback` is the
 * only thing that knows which. Settling is handed back as a thunk rather than
 * done here so ownership can be decided first — `readCallback` throws on an
 * `error=` callback, and that rejection is exactly what an unrelated app would
 * like to hand us.
 */
interface CallbackRead {
  state: string | undefined
  settle: (
    resolve: (result: CallbackResult) => void,
    reject: (error: unknown) => void,
  ) => void
}

function readCallbackUrl(provider: ProviderConfig, url: string): CallbackRead {
  try {
    const result = readCallback(provider, url)

    return { state: result.state, settle: (resolve) => resolve(result) }
  } catch (error) {
    // `readCallback` carries the `state` its parse found onto the error it
    // throws, so even a refusal still says whose it is.
    return {
      state: isOAuthError(error) ? error.state : undefined,
      settle: (_resolve, reject) => reject(error),
    }
  }
}

/**
 * Whether a callback can be answered for by the attempt this receiver presented.
 *
 * Only a `state` that was presented can be compared against. Where none was,
 * there is nothing to compare and the callback is taken as it comes; where one
 * was, silence is a disagreement like any other — a callback that cannot be
 * shown to be ours is not ours, because on these transports "not ours" is the
 * default rather than the exception.
 *
 * A provider declaring `echoesState: false` is the first case even where the
 * URL carried a `state`, because it has said the callback will not bring one
 * back — holding it to a comparison it has already said it cannot satisfy would
 * reject the only callback it can send. The client draws the same exception,
 * with the same caveat: a provider that echoes nothing cannot tell two
 * concurrent attempts apart, so this is for a CLI or a single-flow app rather
 * than a multi-user server.
 */
function belongsToThisAttempt(
  provider: ProviderConfig,
  presentedState: string | undefined,
  callbackState: string | undefined,
): boolean {
  if (presentedState === undefined || provider.echoesState === false) {
    return true
  }

  return callbackState === presentedState
}

/**
 * Receives the callback as an app deep link.
 *
 * Opens the system browser and waits for the OS to route the redirect back into
 * the app.
 *
 * A custom URL scheme is not a private channel: any other app on the device,
 * and any web page the user follows a link from, can send
 * `myapp://auth/callback?...` straight into this handler. So a callback is
 * matched to the attempt this receiver actually presented, by `state`, and one
 * that disagrees is dropped rather than settling the login. Without that, a
 * single unsolicited `?error=access_denied` cancels a sign-in on demand: the
 * client's own `state` comparison only guards the success path, so a `wait()`
 * that rejects is a failed login whatever the callback was.
 *
 * A callback carrying no `state` at all, where one was presented, is dropped
 * too: it cannot be shown to be ours, and on a custom scheme "not ours" is the
 * default rather than the exception. RFC 6749 §4.1.2.1 requires `state` to be
 * echoed on an error response as well as a successful one, so nothing
 * legitimate is turned away; a provider that ignores that rule leaves the login
 * pending instead of failing it, which is what `timeoutMs` and `signal` on
 * `login()` are for. Nothing to compare is not a mismatch, though: a provider
 * that sends no `state` in the first place (OpenRouter builds an authorization
 * URL without one) leaves this receiver with no attempt to tell callbacks apart
 * by, and one is taken as it comes.
 *
 * `wait()` also reads `getInitialURL()`, which is where the OS leaves a
 * redirect it delivered as a launch rather than as a `url` event. The same
 * `state` test decides it: a launch URL belonging to this attempt completes the
 * login, and one left over from an earlier attempt is dropped. That second half
 * is why the test has to be here — `getInitialURL()` does not drain, it keeps
 * returning the launch URL for the life of the process, so an unbound callback
 * would otherwise be replayed into every later login.
 *
 * What this cannot do is resume a `login()` the OS killed mid-flow. The
 * relaunched app calls `createAuthorization()` again, which mints a fresh
 * `state`, so the URL from before the kill belongs to an attempt that no longer
 * exists and is dropped like any other stale one. To finish a flow the OS
 * interrupted, hand the URL to the client yourself, with storage that survives
 * the restart and within the authorization TTL:
 *
 * ```ts
 * const callbackUrl = await Linking.getInitialURL()
 *
 * if (callbackUrl?.startsWith('myapp://auth/callback')) {
 *   await client.completeAuthorization({ callbackUrl })
 * }
 * ```
 */
export function deepLinkReceiver(options: DeepLinkReceiverOptions): CallbackReceiver {
  return {
    id: 'deep-link',
    async start(context: ReceiverContext) {
      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })
      callbackPromise.catch(() => {})

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
       * hold a deep link against — and a deep link arriving in that window is
       * the same unsolicited URL as any other, not an early callback.
       */
      let presented = false

      const handleUrl = (url: string) => {
        if (!presented || pathOfUrl(url) !== pathOfUrl(options.redirectUri)) {
          return
        }

        const callback = readCallbackUrl(context.provider, url)

        if (!belongsToThisAttempt(context.provider, presentedState, callback.state)) {
          return
        }

        callback.settle(resolveCallback, rejectCallback)
      }

      const subscription = options.linking.addEventListener('url', (event) => handleUrl(event.url))

      const onAbort = () => rejectCallback(new OAuthError('aborted', 'Login was aborted.'))
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri: options.redirectUri,
        async present(url) {
          // Read from the URL the client built rather than tracked alongside
          // it, so what this receiver believes its attempt is can never drift
          // from what it actually sent the user to.
          presentedState = stateOfAuthorizationUrl(url)
          presented = true

          await options.linking.openURL(url)
        },
        async wait() {
          const initial = await options.linking.getInitialURL()

          if (initial) {
            handleUrl(initial)
          }

          return callbackPromise
        },
        async close() {
          subscription.remove()
          context.signal?.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}

export interface AuthSessionReceiverOptions {
  /** The `expo-web-browser` module. */
  webBrowser: WebBrowserLike
  /** Your app's callback URL, from `AuthSession.makeRedirectUri()`. */
  redirectUri: string
  /** Extra options forwarded to `openAuthSessionAsync`. */
  browserOptions?: Record<string, unknown>
}

/**
 * Receives the callback through an in-app auth session (Expo).
 *
 * Preferred over deep links on Expo: it uses `SFAuthenticationSession` /
 * Custom Tabs, so the user keeps their provider cookies and the OS closes the
 * sheet automatically on redirect. `openAuthSessionAsync` both presents the URL
 * and returns the result, so `present()` starts it and `wait()` awaits it.
 *
 * The result URL is bound to the attempt by `state`, the same way
 * `deepLinkReceiver` binds a deep link, because on Android it is not
 * necessarily the auth session that produced it. `ASWebAuthenticationSession`
 * on iOS hands back only what its own sheet was redirected to, but Expo's
 * Android implementation opens a Custom Tab and races a `Linking` listener
 * against it, and that listener answers to any app on the device that can send
 * `myapp://auth/callback?…`. An unsolicited `?error=access_denied` therefore
 * resolved `openAuthSessionAsync` as a `success` carrying a hostile URL, which
 * `readCallback` turned into `authorization_denied` — a sign-in cancelled on
 * demand, with an error of somebody else's choosing surfaced to the app as the
 * provider's answer. The receiver is the only place that can be caught: a
 * `wait()` that rejects throws out of `login()` before the client's own `state`
 * comparison, which sits after the await.
 *
 * Be clear about what this does and does not buy. It is a denial of service
 * that is being closed off, not credential injection — a hostile callback
 * carrying a `code` was already stopped by the client's `state` comparison on
 * the success path. And a dropped result cannot be replaced: unlike the
 * deep-link receiver, which keeps listening and can still take the real
 * callback when it arrives, `openAuthSessionAsync` resolves once and is done.
 * So a callback that is not ours leaves `wait()` pending and the login runs to
 * its `timeoutMs` or its `signal` instead of failing immediately. That is worth
 * it: the attempt fails on the app's own terms rather than on an attacker's
 * schedule and in an attacker's words, and `close()` takes the sheet down when
 * it does.
 */
export function authSessionReceiver(options: AuthSessionReceiverOptions): CallbackReceiver {
  return {
    id: 'auth-session',
    async start(context: ReceiverContext) {
      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })
      callbackPromise.catch(() => {})

      /**
       * The `state` of the authorization this receiver actually presented,
       * learned from the URL it was handed rather than tracked separately, so
       * the two cannot disagree.
       */
      let presentedState: string | undefined
      let presented = false

      /**
       * Takes the sheet down, once.
       *
       * Both the abort listener and `close()` ask for this, and on the abort
       * path they both fire: `close()` runs in `login()`'s `finally`, after the
       * signal has already been handled. `dismissAuthSession` is a no-op on a
       * sheet that is already gone, but the guard keeps that an invariant of
       * this file rather than an assumption about someone else's.
       */
      let dismissed = false
      const dismiss = () => {
        if (dismissed) {
          return
        }

        dismissed = true
        options.webBrowser.dismissAuthSession?.()
      }

      const onAbort = () => dismiss()
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri: options.redirectUri,
        async present(url) {
          // Read from the URL the client built rather than tracked alongside
          // it, so what this receiver believes its attempt is can never drift
          // from what it actually sent the user to.
          presentedState = stateOfAuthorizationUrl(url)
          presented = true

          void options.webBrowser
            .openAuthSessionAsync(url, options.redirectUri, options.browserOptions)
            .then((result) => {
              if (result.type !== 'success' || !result.url) {
                // A dismissal is the user's own doing and belongs to this
                // attempt whatever else is going on, so it settles unbound.
                rejectCallback(
                  new OAuthError('aborted', `Sign-in did not complete (${result.type}).`),
                )

                return
              }

              const callback = readCallbackUrl(context.provider, result.url)

              if (!belongsToThisAttempt(context.provider, presentedState, callback.state)) {
                return
              }

              callback.settle(resolveCallback, rejectCallback)
            }, rejectCallback)
        },
        async wait() {
          if (!presented) {
            throw new OAuthError('configuration_error', 'present() must be called before wait().')
          }

          return callbackPromise
        },
        async close() {
          // The signal is not the only way a login ends. `timeoutMs` rejects
          // from the client's own timer without aborting anything, and a
          // `login()` that fails after the callback — a token exchange that is
          // refused — never touches the signal either. Every one of those still
          // reaches `close()`, and without this the sheet stayed up over a flow
          // that no longer existed.
          dismiss()
          context.signal?.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}
