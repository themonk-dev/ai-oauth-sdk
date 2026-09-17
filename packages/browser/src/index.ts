import {
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
  type ProviderLike,
  type TokenSet,
} from '@ai-oauth-sdk/core'

import { popupReceiver } from './popup.js'
import { sessionStorageAdapter } from './storage.js'

export { autoReceiver, currentBrowserOrigin } from './auto.js'
export type { AutoReceiverOptions } from './auto.js'
export { resolveBrowserFlow } from './flow.js'
export type { BrowserFlowResolution, BrowserOrigin, PasteHint } from './flow.js'
export { autoLogin } from './login.js'
export type { AutoLoginOptions } from './login.js'
export { announceCallback, popupReceiver, postCallbackToOpener } from './popup.js'
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
  /* Resolved with `??` *after* the spread: `{ storage: props.storage }` is the
     ordinary way to forward an optional prop, and it puts a present-but-
     `undefined` key in `options`. Spreading over a default would let that key
     erase it, leaving core to fall back to `memoryStorage()` — which both
     breaks flows that cross a page load (`startRedirectLogin` /
     `handleRedirectCallback` lose the PKCE verifier; the popup flow survives
     because the record stays in memory on the same instance) and throws away
     the SSR refusal that `sessionStorageAdapter()` returns off-browser. */
  return createAuthClient({ ...options, storage: options.storage ?? sessionStorageAdapter() })
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
