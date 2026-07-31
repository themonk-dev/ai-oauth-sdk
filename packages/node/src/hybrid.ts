import type {
  CallbackReceiver,
  CallbackResult,
  ReceiverContext,
  StartedReceiver,
} from '@ai-oauth-sdk/core'

import { loopbackReceiver, type LoopbackReceiverOptions } from './loopback.js'
import { promptReceiver } from './prompt.js'

export interface HybridReceiverOptions extends LoopbackReceiverOptions {
  /** Overrides the printed paste instructions. */
  message?: (url: string) => string
}

/**
 * Catches the redirect locally, and falls back to pasting if it never arrives.
 *
 * `--paste` exists for machines whose browser cannot reach the process. But a
 * user who reaches for it on their own laptop got the worst of both: the
 * redirect landed on a port nothing was listening on, so the browser showed
 * "This site can't be reached" and the code was only readable out of the
 * address bar.
 *
 * Since we already know the port, we can simply listen on it. Whichever
 * finishes first wins — the server when the browser is local, the paste prompt
 * when it is not — and the local case never has to copy anything.
 *
 * Both halves must advertise the *same* redirect URI: the provider matches it
 * against the value replayed at the token exchange, and an ephemeral port is
 * only known once the server has bound.
 *
 * Three details keep the race honest:
 *
 * - **The listener is best-effort.** Binding fails when the port is already
 *   held or the sandbox forbids `listen()` — which are precisely the conditions
 *   `--paste` exists to serve — so a failure degrades to the prompt alone
 *   rather than ending the login before the URL is even shown.
 * - **Only the prompt's *success* competes.** A blank line or a mistyped paste
 *   rejects that half, and letting a rejection win would tear down a server
 *   that was about to receive a perfectly good callback.
 * - **Only the prompt announces.** The loopback half is never presented,
 *   because `present()` is what opens the browser, and two halves announcing
 *   means two or three tabs on the same authorization URL.
 */
export function hybridReceiver(options: HybridReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'loopback-or-paste',
    async start(context: ReceiverContext): Promise<StartedReceiver> {
      let loopback: StartedReceiver | undefined

      try {
        loopback = await loopbackReceiver({ ...options, openBrowser: false }).start(context)
      } catch {
        loopback = undefined
      }

      const abandonPrompt = new AbortController()
      const prompt = await promptReceiver({
        ...(loopback ? { redirectUri: loopback.redirectUri } : {}),
        openBrowser: options.openBrowser !== false && !context.openUrl,
        ...(options.message ? { message: options.message } : {}),
        signal: abandonPrompt.signal,
      }).start(context)

      return {
        redirectUri: loopback?.redirectUri ?? prompt.redirectUri,
        async present(url) {
          await prompt.present(url)
        },
        async wait() {
          const server = loopback?.wait()

          if (!server) {
            return prompt.wait()
          }

          const pastedOrNever = prompt
            .wait()
            .catch(() => new Promise<CallbackResult>(() => {}))

          try {
            return await Promise.race([server, pastedOrNever])
          } finally {
            abandonPrompt.abort()
          }
        },
        async close() {
          abandonPrompt.abort()
          await Promise.allSettled([loopback?.close() ?? Promise.resolve(), prompt.close()])
        },
      }
    },
  }
}
