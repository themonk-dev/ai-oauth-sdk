import {
  OAuthError,
  readCallback,
  type CallbackReceiver,
  type CallbackResult,
  type ReceiverContext,
} from '@ai-oauth-sdk/core'

export interface PopupReceiverOptions {
  /** Redirect URI — a page on your origin that runs {@link postCallbackToOpener}. */
  redirectUri?: string
  width?: number
  height?: number
  /** Popup window name. */
  windowName?: string
  /** How often to check whether the user closed the popup. Default 400ms. */
  pollIntervalMs?: number
}

const MESSAGE_TYPE = 'aioauth:callback'

/**
 * Receives the callback in a popup window.
 *
 * Keeps the host page alive — no navigation, no state to rehydrate — which
 * makes it the nicest option for an SPA. Your redirect page must call
 * {@link postCallbackToOpener}; the popup is same-origin with the opener at
 * that point, so it can hand the code back over `postMessage`. Messages from
 * any other origin are ignored — by the time the popup posts it is same-origin,
 * so anything else is not ours.
 *
 * The `window` guard runs before anything touches `window`, or it would never
 * run at all: deriving the default `redirectUri` first would throw a bare
 * `ReferenceError`. A closed popup is polled for because it is the only signal
 * the browser gives that the user gave up.
 */
export function popupReceiver(options: PopupReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'popup',
    async start(context: ReceiverContext) {
      if (typeof window === 'undefined') {
        throw new OAuthError('unsupported_runtime', 'popupReceiver requires a browser window.')
      }

      const redirectUri = options.redirectUri ?? window.location.href.split('#')[0]!

      let popup: Window | null = null
      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })
      callbackPromise.catch(() => {})

      let closedPoller: ReturnType<typeof setInterval> | undefined

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return
        }

        const data = event.data as { type?: string; payload?: string } | null

        if (!data || data.type !== MESSAGE_TYPE || typeof data.payload !== 'string') {
          return
        }

        try {
          resolveCallback(readCallback(context.provider, data.payload))
        } catch (error) {
          rejectCallback(error)
        }
      }

      window.addEventListener('message', onMessage)

      const cleanup = () => {
        window.removeEventListener('message', onMessage)

        if (closedPoller) {
          clearInterval(closedPoller)
        }

        context.signal?.removeEventListener('abort', onAbort)
      }

      const onAbort = () => {
        rejectCallback(new OAuthError('aborted', 'Login was aborted.'))
        popup?.close()
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })

      return {
        redirectUri,
        async present(url) {
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

          closedPoller = setInterval(() => {
            if (popup?.closed) {
              clearInterval(closedPoller)
              rejectCallback(
                new OAuthError('aborted', 'The sign-in window was closed before completing.'),
              )
            }
          }, options.pollIntervalMs ?? 400)
        },
        wait: () => callbackPromise,
        async close() {
          cleanup()

          if (popup && !popup.closed) {
            popup.close()
          }
        },
      }
    },
  }
}

/**
 * Call this on your redirect page to hand the callback back to the opener.
 *
 * ```html
 * <script type="module">
 *   import { postCallbackToOpener } from 'https://esm.sh/@ai-oauth-sdk/browser'
 *   postCallbackToOpener()
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
