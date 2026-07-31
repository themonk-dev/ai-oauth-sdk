import {
  OAuthError,
  readCallback,
  type CallbackReceiver,
  type CallbackResult,
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
 * Receives the callback as an app deep link.
 *
 * Opens the system browser and waits for the OS to route the redirect back into
 * the app. Also checks `getInitialURL()`, because a cold start (the OS killed
 * the app while the user was on the consent screen) delivers the URL that way
 * instead of through the `url` event.
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

      const handleUrl = (url: string) => {
        if (!url.startsWith(options.redirectUri.split('?')[0]!)) {
          return
        }

        try {
          resolveCallback(readCallback(context.provider, url))
        } catch (error) {
          rejectCallback(error)
        }
      }

      const subscription = options.linking.addEventListener('url', (event) => handleUrl(event.url))

      const onAbort = () => rejectCallback(new OAuthError('aborted', 'Login was aborted.'))
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri: options.redirectUri,
        async present(url) {
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
 */
export function authSessionReceiver(options: AuthSessionReceiverOptions): CallbackReceiver {
  return {
    id: 'auth-session',
    async start(context: ReceiverContext) {
      let pending: Promise<CallbackResult> | undefined

      const onAbort = () => options.webBrowser.dismissAuthSession?.()
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri: options.redirectUri,
        async present(url) {
          pending = options.webBrowser
            .openAuthSessionAsync(url, options.redirectUri, options.browserOptions)
            .then((result) => {
              if (result.type !== 'success' || !result.url) {
                throw new OAuthError(
                  'aborted',
                  `Sign-in did not complete (${result.type}).`,
                )
              }

              return readCallback(context.provider, result.url)
            })
        },
        async wait() {
          if (!pending) {
            throw new OAuthError('configuration_error', 'present() must be called before wait().')
          }

          return pending
        },
        async close() {
          context.signal?.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}
