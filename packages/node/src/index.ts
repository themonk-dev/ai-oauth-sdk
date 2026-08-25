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
import { hybridReceiver } from './hybrid.js'
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
 * same host, so a headless environment — no `DISPLAY`, or an explicit SSH
 * session — gets a receiver the user can finish by hand. Which one depends on
 * what the provider supports.
 *
 * A provider that publishes a hosted callback page, such as Claude, takes that
 * route once the machine is headless: the page *shows* the user a code, so it
 * is the best thing there is to paste from. Sending a remote box's `localhost`
 * URI to a browser on the user's laptop produces a redirect nothing can
 * receive and a command that hangs, with no device flow to fall back to.
 *
 * Every other loopback provider — `openai`, `gemini`, `xai`, `openrouter` —
 * gets the hybrid, which binds the port *and* offers the paste prompt, because
 * "headless" does not actually settle where the browser is. A container with
 * host networking, or a display-less box the user opens the URL on themselves
 * from a browser that shares its network namespace, resolves the redirect
 * locally and completes with nothing to copy. A user typing into an SSH shell
 * sees "this site can't be reached" and pastes that URL back instead. Handing
 * that second user a bare loopback server, as this used to, binds a port on the
 * *remote* box while the browser redirects to their laptop's `localhost:1455`,
 * where nothing of ours is listening — so the login waits out `timeoutMs`, or
 * forever.
 *
 * A `custom`-mode provider (`github-copilot`, `qwen`) has no redirect for any
 * receiver here to catch, on any machine. It gets the prompt, whose refusal
 * names `deviceLogin()`/`--device` — the flow those providers do support — in
 * preference to binding a port and advertising a redirect URI they accept no
 * registration for.
 */
export function defaultReceiver(provider: {
  redirect: { mode: string; hostedUri?: string }
}): CallbackReceiver {
  const isRemote = Boolean(process.env['SSH_TTY'] ?? process.env['SSH_CONNECTION'])
  const isHeadless = !canOpenBrowser() || isRemote

  if (provider.redirect.mode === 'custom') {
    return promptReceiver()
  }

  if (provider.redirect.mode === 'loopback' && !isHeadless) {
    return loopbackReceiver()
  }

  if (provider.redirect.mode === 'hosted' || provider.redirect.hostedUri) {
    return promptReceiver()
  }

  /* The wording `--paste` already uses for the same arrangement, because it is
     the same arrangement: a port is listening, and the line about "this site
     can't be reached" is the one thing that tells a user whose browser is
     elsewhere that the error page in front of them is the answer, not a
     failure. `openBrowser` stays off — this branch was reached by concluding
     there is no browser here to open. */
  return hybridReceiver({
    openBrowser: false,
    message: (url) =>
      `\nOpen this URL to sign in:\n\n  ${url}\n\n` +
      'Waiting for the redirect — if your browser is on another machine it will show\n' +
      '"This site can\'t be reached"; paste that URL here instead.\n',
  })
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
