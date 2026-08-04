import {
  manualReceiver,
  OAuthError,
  type CallbackReceiver,
  type ReceiverContext,
} from '@ai-oauth-sdk/core'

import { resolveBrowserFlow, type BrowserOrigin, type PasteHint } from './flow.js'
import { popupReceiver, type PopupReceiverOptions } from './popup.js'

export interface AutoReceiverOptions {
  /** Origin to resolve the flow against. Defaults to `window.location`. */
  origin?: BrowserOrigin
  /** Forwarded to {@link popupReceiver} when the resolved flow is a popup. */
  popup?: Omit<PopupReceiverOptions, 'redirectUri'>
  /**
   * Shows the authorization URL and returns whatever the user pastes back,
   * for a provider that resolves to `paste`. The `hint` is
   * {@link resolveBrowserFlow}'s explanation of what the redirect will
   * actually do, so the prompt can word itself correctly — "watch for a code
   * on this page" reads wrong for a provider that instead strands the user on
   * a dead `localhost` URL.
   *
   * Required only if a `paste` provider is ever routed through this receiver;
   * omitting it is fine for an app that only uses popup-capable providers,
   * and fails with a clear error the moment it is not.
   */
  prompt?: (url: string, hint: PasteHint, context: ReceiverContext) => Promise<string>
}

/**
 * Reads the origin `resolveBrowserFlow` needs off `window.location`.
 *
 * Exported for `autoLogin` in `login.ts`, which resolves the flow
 * itself before deciding whether `autoReceiver` even applies — a `device`
 * provider needs `client.deviceLogin()` instead, and by the time a
 * `CallbackReceiver` is involved that decision has to already be made.
 */
export function currentBrowserOrigin(): BrowserOrigin {
  if (typeof window === 'undefined') {
    throw new OAuthError('unsupported_runtime', 'autoReceiver requires a browser window.')
  }

  // `Location` has more than `protocol`/`hostname`/`port`, but that is fine
  // for a value being assigned to a narrower interface — only object literals
  // get the excess-property check.
  return window.location
}

/**
 * Picks the browser sign-in flow {@link resolveBrowserFlow} says will work
 * for this provider on this origin, and delegates to the receiver that runs
 * it — `popupReceiver` or `manualReceiver`.
 *
 * Opt-in only: not `login()`'s default and not wired into
 * `createBrowserAuthClient()`. A caller that already picked a receiver keeps
 * it; this exists for the one that would otherwise have to reimplement the
 * decision table in the design note themselves.
 *
 * A provider that resolves to `device` is refused rather than silently
 * running some other flow. `client.deviceLogin()` is a different entry point
 * with a different shape — it polls a token endpoint instead of catching a
 * redirect — so there is no receiver this could delegate to that would
 * actually complete the login. Failing loudly here, before any UI is shown
 * and before `login()` even creates an authorization, is preferable to a
 * receiver that opens a popup to a page with no code on it. Check
 * `resolveBrowserFlow(provider, origin).flow` before calling `login()` to
 * route `device` providers to `deviceLogin()` instead of hitting this.
 */
export function autoReceiver(options: AutoReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'auto',
    async start(context: ReceiverContext) {
      const origin = options.origin ?? currentBrowserOrigin()
      const resolution = resolveBrowserFlow(context.provider, origin)

      if (resolution.flow === 'device') {
        throw new OAuthError(
          'configuration_error',
          `Provider "${context.provider.id}" has no browser redirect this origin can use — its only ` +
            'working flow here is the device code grant, which is not a callback receiver. Call ' +
            'client.deviceLogin() for this provider instead of client.login({ receiver: autoReceiver() }).',
        )
      }

      if (resolution.flow === 'popup') {
        return popupReceiver({ ...options.popup, redirectUri: resolution.redirectUri }).start(context)
      }

      const { prompt } = options
      const { hint } = resolution

      if (!prompt) {
        throw new OAuthError(
          'configuration_error',
          `Provider "${context.provider.id}" can only be completed by pasting a code back on this ` +
            'origin. Pass `prompt` to autoReceiver() to collect it.',
        )
      }

      return manualReceiver({ prompt: (url, ctx) => prompt(url, hint, ctx) }).start(context)
    },
  }
}
