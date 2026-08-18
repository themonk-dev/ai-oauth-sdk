import {
  isOAuthError,
  type CallbackReceiver,
  type CallbackResult,
  type ReceiverContext,
  type StartedReceiver,
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
 * - **The listener is best-effort about the machine, never about the address.**
 *   A sandbox that forbids `listen()` is precisely the condition `--paste`
 *   exists to serve: the redirect URI stays unclaimed because nothing here can
 *   claim it, so degrading to the prompt alone costs the user a copy and
 *   nothing else. A port already *held* is the opposite situation. Someone else
 *   is listening on the exact URI both halves are about to advertise, so
 *   dropping the loopback half would print an authorization URL naming an
 *   address this process does not own, and the browser would deliver the code
 *   to whoever does — while the terminal sat at the paste prompt looking
 *   patient. `loopbackReceiver()` already refuses to start under that
 *   arrangement, for a fixed port taken outright and for the sibling address a
 *   name like `localhost` also resolves to; the refusal has to survive being
 *   wrapped, or `--paste` quietly becomes the way around it.
 *
 *   The two are told apart by type rather than by errno: a refusal is an
 *   `OAuthError` and a kernel saying no is not, so `OAuthError` is rethrown and
 *   everything else degrades. That is deliberately coarser than matching a
 *   specific code — `start()` throws an `OAuthError` only when it has decided
 *   the login should not proceed, and any later reason it decides that should
 *   propagate here too without this file having to be edited again.
 * - **Only the prompt's *success* competes.** A blank line or a mistyped paste
 *   rejects that half, and letting a rejection win would tear down a server
 *   that was about to receive a perfectly good callback.
 * - **Only the prompt announces, but both halves are presented.** The loopback
 *   half needs `present()` to learn the `state` it matches callbacks against,
 *   or the drive-by cancellation that check exists to stop is simply reopened
 *   under `--paste`. So it is presented too — silently. Its `openBrowser` is
 *   already forced off, its `onAuthorizationUrl` is stripped, and it is started
 *   on a context with no `openUrl`, which between them are every way
 *   `present()` can announce anything. The prompt keeps all three, so the URL
 *   is shown exactly once and a browser opened at most once, whichever of
 *   `context.openUrl` and `openBrowser` is in play. Stripping
 *   `onAuthorizationUrl` costs nothing today — it never fired here, since the
 *   loopback half was never presented — and keeping it would print the URL a
 *   second time.
 */
export function hybridReceiver(options: HybridReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'loopback-or-paste',
    async start(context: ReceiverContext): Promise<StartedReceiver> {
      let loopback: StartedReceiver | undefined

      /* Every announcing channel removed from the loopback half: the printed
         URL, the browser launch, and the caller's own opener. Presenting it is
         what binds it to the attempt; announcing twice is what that must not
         cost. */
      const { onAuthorizationUrl: _announce, ...quietOptions } = options
      const quietContext: ReceiverContext = {
        provider: context.provider,
        ...(context.signal ? { signal: context.signal } : {}),
      }

      try {
        loopback = await loopbackReceiver({ ...quietOptions, openBrowser: false }).start(
          quietContext,
        )
      } catch (error) {
        /* A refusal, not an unusable machine — see the note above. Pasting past
           it would advertise a redirect URI someone else is holding. */
        if (isOAuthError(error)) {
          throw error
        }

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
          /* First and silently, so the server is bound to this attempt before
             the URL reaches the user and any callback can arrive. */
          await loopback?.present(url)
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
