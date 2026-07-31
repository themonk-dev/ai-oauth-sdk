import {
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
  type ProviderLike,
  type TokenSet,
} from '@ai-oauth-sdk/core'

import { popupReceiver } from './popup.js'
import { sessionStorageAdapter } from './storage.js'

export { popupReceiver, postCallbackToOpener } from './popup.js'
export type { PopupReceiverOptions } from './popup.js'
export { handleRedirectCallback, redirectReceiver, startRedirectLogin } from './redirect.js'
export type { HandleRedirectCallbackOptions, RedirectReceiverOptions } from './redirect.js'
export { localStorageAdapter, sessionStorageAdapter } from './storage.js'
export * from '@ai-oauth-sdk/core'

export interface BrowserClientOptions extends AuthClientOptions {
  /**
   * Where to keep tokens. Defaults to `sessionStorage` — it survives the
   * redirect round-trip but not the tab, which is the safer default for
   * bearer tokens in a browser.
   */
  storage?: AuthClientOptions['storage']
}

/** An {@link AuthClient} preconfigured for the browser. */
export function createBrowserAuthClient(options: BrowserClientOptions): AuthClient {
  return createAuthClient({ storage: sessionStorageAdapter(), ...options })
}

export interface BrowserLoginOptions extends Omit<BrowserClientOptions, 'provider'> {
  signal?: AbortSignal
  timeoutMs?: number
  scopes?: string[]
}

/**
 * Popup sign-in. Must be called from a user gesture or the popup is blocked.
 *
 * ```ts
 * button.onclick = () => loginWithPopup('openai', { clientId, redirectUri })
 * ```
 */
export async function loginWithPopup(
  provider: ProviderLike,
  options: BrowserLoginOptions & { redirectUri?: string } = {},
): Promise<TokenSet> {
  const { signal, timeoutMs, scopes, ...clientOptions } = options
  const client = createBrowserAuthClient({ ...clientOptions, provider })

  return client.login({
    receiver: popupReceiver(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(scopes ? { scopes } : {}),
  })
}
