import { createInterface } from 'node:readline/promises'
import { stderr, stdin } from 'node:process'

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
 * Everything the human reads goes to **stderr**, which is the contract the CLI
 * states in `packages/cli/src/output.ts`: stdout is the data channel and nothing
 * else may appear on it. Both halves of this have to move for that to hold.
 * Writing the instructions to stdout is the obvious half; the readline interface
 * is the one that is easy to miss, because it writes its own prompt string
 * through `output` and does so even when `terminal` is false. So
 * `ai-oauth-sdk login claude --paste --json > out.json` used to put the
 * instructions *and* "Paste the authorization code or URL: " into the captured
 * file — which then did not parse as JSON — while the user sat looking at a
 * terminal that was, as far as they could tell, hung on nothing.
 *
 * This is a channel bug and not a credential leak. With stdout redirected,
 * readline sees a non-TTY `output`, sets `terminal` false and echoes nothing;
 * what the user sees themselves type is the tty's own local echo of stdin,
 * which never enters the redirected stream. Nothing pasted was ever captured.
 *
 * Moving `output` does change what readline decides `terminal` is — it now
 * follows `stderr.isTTY` rather than `stdout.isTTY`. That is the reading we
 * want: `terminal` governs how the *prompt* is drawn, and the prompt is now
 * drawn on stderr, so it should track whether stderr is a terminal. It also
 * gives the redirected case the better behaviour, since a piped stdout with a
 * tty stderr now gets a real prompt instead of a silent read.
 */
export function promptReceiver(options: PromptReceiverOptions = {}): CallbackReceiver {
  return manualReceiver({
    ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
    async prompt(url) {
      stderr.write((options.message ?? defaultMessage)(url))

      if (options.openBrowser !== false) {
        openBrowser(url)
      }

      const rl = createInterface({ input: stdin, output: stderr })

      try {
        const answer = await rl.question(
          'Paste the authorization code or URL: ',
          options.signal ? { signal: options.signal } : {},
        )

        return answer.trim()
      } finally {
        rl.close()
      }
    },
  })
}
