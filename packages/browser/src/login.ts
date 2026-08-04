import {
  OAuthError,
  type AuthClient,
  type DeviceCodeResponse,
  type TokenSet,
} from '@ai-oauth-sdk/core'

import { autoReceiver, currentBrowserOrigin, type AutoReceiverOptions } from './auto.js'
import { resolveBrowserFlow, type BrowserOrigin } from './flow.js'

export interface AutoLoginOptions {
  signal?: AbortSignal
  timeoutMs?: number
  scopes?: string[]
  extraParams?: Record<string, string>
  metadata?: Record<string, unknown>
  /** Origin to resolve the flow against. Defaults to `window.location`. */
  origin?: BrowserOrigin
  /** Forwarded to `autoReceiver()` when the resolved flow is `popup`. */
  popup?: AutoReceiverOptions['popup']
  /** Forwarded to `autoReceiver()` when the resolved flow is `paste`. */
  prompt?: AutoReceiverOptions['prompt']
  /**
   * Shows the user code and verification URL, for a provider whose only
   * working browser flow is the device grant. The device flow is inherently
   * interactive on someone else's screen — there is no redirect to wait on —
   * so this is required exactly when {@link resolveBrowserFlow} would answer
   * `device`, and unused otherwise.
   */
  onCode?: (device: DeviceCodeResponse) => void | Promise<void>
}

/**
 * The one call that does the right thing: resolves which flow this provider
 * and origin actually support, and runs it — a popup or a paste through
 * `autoReceiver()`, or `client.deviceLogin()` for a provider with no working
 * browser redirect here (`openai`, `xai`, `github-copilot`, `qwen`, all of
 * them off a deployed origin; `openai` even off a loopback one).
 *
 * Exists because `autoReceiver()` alone cannot cover this: `login()` and
 * `deviceLogin()` are different entry points on {@link AuthClient}, and no
 * `CallbackReceiver` — the seam `login()` runs through — can turn one into
 * the other. Something has to resolve the flow *before* choosing which entry
 * point to call, and this is that something, so a caller who does not care
 * which flow ran does not have to branch on `resolveBrowserFlow` themselves.
 *
 * A caller who *does* care — to render a device-code panel instead of a
 * popup button before anything starts — should call
 * {@link resolveBrowserFlow} directly and branch in the UI; this function
 * makes the same decision but only acts on it.
 */
export async function autoLogin(
  client: AuthClient,
  options: AutoLoginOptions = {},
): Promise<TokenSet> {
  const origin = options.origin ?? currentBrowserOrigin()
  const resolution = resolveBrowserFlow(client.provider, origin)

  if (resolution.flow === 'device') {
    if (!options.onCode) {
      throw new OAuthError(
        'configuration_error',
        `Provider "${client.provider.id}" has no browser redirect this origin can use, so ` +
          'autoLogin() must run the device code grant, which needs somewhere to show the ' +
          'user the code and verification URL. Pass `onCode` to autoLogin() to receive them.',
      )
    }

    return client.deviceLogin({
      onCode: options.onCode,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.scopes ? { scopes: options.scopes } : {}),
    })
  }

  return client.login({
    receiver: autoReceiver({
      origin,
      ...(options.popup ? { popup: options.popup } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.extraParams ? { extraParams: options.extraParams } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
}
