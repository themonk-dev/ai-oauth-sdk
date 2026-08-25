import {
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
  type ProviderLike,
  type TokenSet,
} from '@ai-oauth-sdk/core'

import { popupReceiver, type PopupReceiverOptions } from './popup.js'
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
 *
 * Accepts the receiver's own options alongside the client's and hands them
 * over. This used to forward `redirectUri` alone, which made every other one
 * unreachable from the entry point the quick-start and both READMEs teach —
 * `pollForClose` in particular, whose whole purpose is to rescue an app whose
 * `Cross-Origin-Opener-Policy: same-origin` breaks the close-poll, and whose
 * author would have had to abandon this helper for `client.login({ receiver:
 * popupReceiver(…) })` to reach it.
 */
export async function loginWithPopup(
  provider: ProviderLike,
  options: BrowserLoginOptions & PopupReceiverOptions = {},
): Promise<TokenSet> {
  // Split rather than spread wholesale in both directions: a popup dimension is
  // not something to configure a client with. Destructured by name so what is
  // left over is a `BrowserLoginOptions` the compiler can see, rather than a
  // bag that has to be cast back into one.
  //
  // `redirectUri` is deliberately not pulled out. It belongs to both halves —
  // the receiver needs it, and it is an `AuthClientOptions` key that has always
  // reached the client too — so it stays in the rest and is copied across
  // rather than moved.
  //
  // A popup option added to `PopupReceiverOptions` later has to be named here
  // and in `receiverOptions` below, or it will land in the client's options and
  // quietly do nothing.
  const {
    signal,
    timeoutMs,
    scopes,
    width,
    height,
    windowName,
    pollIntervalMs,
    pollForClose,
    ...clientOptions
  } = options

  // Keys are copied only when actually present, so an option left out stays
  // "not passed" and keeps the receiver's own default, rather than arriving as
  // an explicit `undefined` that a `?? default` would still catch but a
  // `!== false` test would not.
  const receiverOptions: PopupReceiverOptions = {
    ...(clientOptions.redirectUri !== undefined ? { redirectUri: clientOptions.redirectUri } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(windowName !== undefined ? { windowName } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(pollForClose !== undefined ? { pollForClose } : {}),
  }

  const client = createBrowserAuthClient({ ...clientOptions, provider })

  return client.login({
    receiver: popupReceiver(receiverOptions),
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(scopes ? { scopes } : {}),
  })
}
