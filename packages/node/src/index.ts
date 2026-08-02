import {
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
  type CallbackReceiver,
  type ProviderLike,
  type TokenSet,
} from '@ai-oauth-sdk/core'

import { canOpenBrowser } from './browser.js'
import { nodeCrypto } from './crypto.js'
import { loopbackReceiver } from './loopback.js'
import { promptReceiver } from './prompt.js'
import { fileStorage } from './storage.js'

export { canOpenBrowser, openBrowser } from './browser.js'
export { nodeCrypto } from './crypto.js'
export { loopbackReceiver } from './loopback.js'
export type { LoopbackReceiverOptions } from './loopback.js'
export { promptReceiver } from './prompt.js'
export { hybridReceiver } from './hybrid.js'
export type { HybridReceiverOptions } from './hybrid.js'
export type { PromptReceiverOptions } from './prompt.js'
export { defaultAuthDir, fileStorage, listStoredSessions } from './storage.js'
export type { FileStorageOptions, StoredSession } from './storage.js'
export * from '@ai-oauth-sdk/core'

/**
 * Picks the receiver that fits the machine.
 *
 * A loopback server only works when the browser and this process are on the
 * same host, so headless environments (no `DISPLAY`, or an explicit SSH
 * session) fall back to paste. Providers that only support a hosted redirect
 * skip loopback entirely.
 *
 * A provider that supports *both*, such as Claude, which prefers loopback locally
 * but publishes a page that displays the code — takes the hosted route once the
 * machine is headless. Sending a remote box's `localhost` URI to a browser on
 * the user's laptop produces a redirect nothing can receive and a command that
 * hangs, with no device flow to fall back to.
 */
export function defaultReceiver(provider: {
  redirect: { mode: string; hostedUri?: string }
}): CallbackReceiver {
  const isRemote = Boolean(process.env['SSH_TTY'] ?? process.env['SSH_CONNECTION'])
  const isHeadless = !canOpenBrowser() || isRemote

  if (provider.redirect.mode === 'loopback' && !isHeadless) {
    return loopbackReceiver()
  }

  if (provider.redirect.mode === 'hosted' || provider.redirect.hostedUri) {
    return promptReceiver()
  }

  return loopbackReceiver({ openBrowser: false, onAuthorizationUrl: (url) => {
    process.stdout.write(`\nOpen this URL to sign in:\n\n  ${url}\n\n`)
  } })
}

export interface NodeClientOptions extends Omit<AuthClientOptions, 'storage'> {
  /** Defaults to a `0600` JSON file under `~/.ai-oauth-sdk`. */
  storage?: AuthClientOptions['storage']
  /** Persist tokens to disk. Default true. Set false for in-memory only. */
  persist?: boolean
  /** Directory for the credential file when `persist` is on. */
  authDir?: string
}

/**
 * An {@link AuthClient} preconfigured for Node: file-backed storage and
 * `node:crypto`, so it never depends on `globalThis.crypto` being exposed.
 */
export function createNodeAuthClient(options: NodeClientOptions): AuthClient {
  const { persist = true, authDir, ...rest } = options

  let storage = rest.storage

  if (!storage && persist) {
    storage = fileStorage(authDir ? { dir: authDir } : {})
  }

  return createAuthClient({
    crypto: nodeCrypto(),
    ...rest,
    ...(storage ? { storage } : {}),
  })
}

export interface NodeLoginOptions extends Omit<NodeClientOptions, 'provider'> {
  /** Override the auto-selected receiver. */
  receiver?: CallbackReceiver
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * One-call sign-in for CLIs: picks a receiver, opens the browser, waits for the
 * callback, stores the tokens, and returns them.
 *
 * ```ts
 * const tokens = await login('openai')
 * ```
 */
export async function login(
  provider: ProviderLike,
  options: NodeLoginOptions = {},
): Promise<TokenSet> {
  const { receiver, signal, timeoutMs, ...clientOptions } = options
  const client = createNodeAuthClient({ ...clientOptions, provider })

  return client.login({
    receiver: receiver ?? defaultReceiver(client.provider),
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}
