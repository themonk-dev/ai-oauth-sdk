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

/** A callback that has been read but not yet allowed to settle the login. */
interface HeldCallback {
  state: string | undefined
  settle: (resolve: (result: CallbackResult) => void, reject: (error: unknown) => void) => void
}

/**
 * The provider's own read of a callback URL, with the outcome it represents
 * held rather than applied.
 *
 * The `state` has to come from the same parser the client will use: providers
 * disagree about where the callback params live, and `parseCallback` is the
 * only thing that knows which. Settling is held back so ownership can be
 * decided first — `readCallback` throws on an `error=` callback, and that
 * rejection is exactly what an unrelated app, or an unrelated page, would like
 * to hand us. Reading and settling in one step would let the throw decide the
 * login before anyone has asked whose callback it is.
 *
 * Shared by both receivers rather than written twice. The two take delivery of
 * a callback by different means — an OS deep link and an in-app auth session —
 * but the question they have to answer about it is the same one, and a copy
 * that drifts is how one of them silently loses the check.
 */
function readHeld(provider: ProviderConfig, url: string): HeldCallback {
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
 * Whether a callback can be answered for by the attempt that was presented.
 *
 * Only a `state` that was presented can be answered for. Where none was, there
 * is nothing to compare and the callback is taken as it comes; where one was,
 * silence is a disagreement like any other — a callback carrying no `state`
 * cannot be shown to be ours, and RFC 6749 §4.1.2.1 requires `state` to be
 * echoed on an error response as well as a successful one, so nothing
 * legitimate is turned away.
 *
 * A provider declaring `echoesState: false` is the first case even where the
 * URL carried a `state`, because it has said the callback will not bring one
 * back — holding it to a comparison it has already said it cannot satisfy would
 * reject the only callback it can send. The client draws the same exception,
 * with the same caveat: a provider that echoes nothing cannot tell two
 * concurrent attempts apart, so this is for a CLI or a single-flow app rather
 * than a multi-user server.
 */
function belongsToAttempt(
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

        // Read without settling, so the `error=` callback's rejection cannot
        // fail the login before ownership has been judged.
        const callback = readHeld(context.provider, url)

        if (!belongsToAttempt(context.provider, presentedState, callback.state)) {
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
 * The URL that session hands back is not self-evidently ours, so it is bound to
 * the attempt exactly as {@link deepLinkReceiver} binds a deep link, and for
 * the same reasons. `openAuthSessionAsync` completes on the first URL matching
 * the redirect the OS was given, and on Android that match is a registered
 * scheme, which any other app on the device may also have registered and which
 * any web page can navigate to. So the result is checked for the redirect URI's
 * whole path and then for the `state` this receiver actually presented, and one
 * that fails either is dropped rather than settling the login. Without that, a
 * single `?error=access_denied` arriving on this path cancels a sign-in on
 * demand: the client's own `state` comparison only guards the success path, so
 * a `wait()` that rejects is a failed login whatever the callback was.
 *
 * Dropping means leaving `wait()` pending, never rejecting — a rejection is the
 * cancel-a-sign-in primitive this is here to remove, so refusing a callback
 * must not be a way to spell it. The login then ends on `timeoutMs` or
 * `signal`, which is what they are for.
 *
 * A session that did not end in a redirect at all is a different matter and
 * still fails fast: `type` other than `'success'` is the user closing the
 * sheet, reported by the OS about the session this receiver itself opened, so
 * there is nothing to mistake it for and nothing to gain by waiting.
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

      /**
       * Whether `present()` has run. `wait()` has no session to await before
       * it does, and says so rather than hanging.
       */
      let presented = false

      const onAbort = () => options.webBrowser.dismissAuthSession?.()
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri: options.redirectUri,
        async present(url) {
          // Read from the URL the client built rather than tracked alongside
          // it, so what this receiver believes its attempt is can never drift
          // from what it actually sent the user to.
          presentedState = stateOfAuthorizationUrl(url)
          presented = true

          // The session's own promise no longer settles the login; it feeds
          // the same held-then-decided path a deep link goes through, and a
          // callback that is not ours simply never settles it.
          void options.webBrowser
            .openAuthSessionAsync(url, options.redirectUri, options.browserOptions)
            .then((result) => {
              if (result.type !== 'success' || !result.url) {
                rejectCallback(
                  new OAuthError('aborted', `Sign-in did not complete (${result.type}).`),
                )

                return
              }

              if (pathOfUrl(result.url) !== pathOfUrl(options.redirectUri)) {
                return
              }

              const callback = readHeld(context.provider, result.url)

              if (!belongsToAttempt(context.provider, presentedState, callback.state)) {
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
          context.signal?.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}
