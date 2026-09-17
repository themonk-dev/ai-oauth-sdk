import { createInterface, type Interface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { manualReceiver, type CallbackReceiver } from '@ai-oauth-sdk/core'

import { openBrowser } from './browser.js'

export interface PromptReceiverOptions {
  /** Redirect URI. Defaults to the provider's hosted callback. */
  redirectUri?: string
  /** Try to open a browser as well as printing the URL. Default true. */
  openBrowser?: boolean
  /** Overrides the printed instructions. */
  message?: (url: string) => string
  /** Abandons the pending read, for racing this against another receiver. */
  signal?: AbortSignal
  /**
   * Ask again when a paste cannot be read as a code, instead of failing the
   * login. Default false.
   *
   * Only turn this on where something other than the user can end the wait —
   * a receiver racing this one, or `signal`. On its own the prompt is the only
   * way the login can finish, and a user holding an unparseable value would
   * have nothing to do but Ctrl-C. A pasted *denial* is never retried either
   * way: the provider answered, and the answer was no.
   */
  retryOnInvalidPaste?: boolean
}

const defaultMessage = (url: string) =>
  `\nOpen this URL to sign in:\n\n  ${url}\n\nThen paste the value you are given here.\n`

/**
 * Prints the URL, waits for the user to paste the result on stdin.
 *
 * The right default for SSH sessions, containers, and CI — anywhere the browser
 * runs on a different machine than the process, so a loopback server would
 * never receive the redirect.
 *
 * The instructions and the browser launch belong to the login, not to the
 * question, so they happen once however many times the user is asked. The
 * readline interface is the same: one per login rather than one per question,
 * because closing it is what makes the *next* line the user types unreadable.
 * It is closed when the login ends — when `wait()` settles, or on `close()`.
 */
export function promptReceiver(options: PromptReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'manual',
    async start(context) {
      let input: Interface | undefined
      let announced = false

      const closeInput = () => {
        input?.close()
        input = undefined
      }

      const started = await manualReceiver({
        ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
        ...(options.retryOnInvalidPaste
          ? {
              retry: (error) => {
                /* A denial is an answer. Asking again would be asking the user
                   to produce a code the provider has already refused to issue,
                   so it travels on to the caller and ends the login. */
                if (error.code !== 'invalid_token_response') {
                  return false
                }

                stdout.write(`\n${error.message} Paste the whole URL, or press Ctrl-C to give up.\n`)

                return true
              },
            }
          : {}),
        async prompt(url) {
          if (!announced) {
            announced = true
            stdout.write((options.message ?? defaultMessage)(url))

            if (options.openBrowser !== false) {
              openBrowser(url)
            }
          }

          input ??= createInterface({ input: stdin, output: stdout })

          const answer = await input.question(
            'Paste the authorization code or URL: ',
            options.signal ? { signal: options.signal } : {},
          )

          return answer.trim()
        },
      }).start(context)

      return {
        ...started,
        async wait() {
          try {
            return await started.wait()
          } finally {
            closeInput()
          }
        },
        async close() {
          closeInput()
          await started.close()
        },
      }
    },
  }
}
