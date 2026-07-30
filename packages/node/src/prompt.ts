import { createInterface } from 'node:readline/promises'
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
}

const defaultMessage = (url: string) =>
  `\nOpen this URL to sign in:\n\n  ${url}\n\nThen paste the value you are given here.\n`

/**
 * Prints the URL, waits for the user to paste the result on stdin.
 *
 * The right default for SSH sessions, containers, and CI — anywhere the browser
 * runs on a different machine than the process, so a loopback server would
 * never receive the redirect.
 */
export function promptReceiver(options: PromptReceiverOptions = {}): CallbackReceiver {
  return manualReceiver({
    ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
    async prompt(url) {
      stdout.write((options.message ?? defaultMessage)(url))
      if (options.openBrowser !== false) {
        openBrowser(url)
      }

      const rl = createInterface({ input: stdin, output: stdout })
      try {
        const answer = await rl.question('Paste the authorization code or URL: ')
        return answer.trim()
      } finally {
        rl.close()
      }
    },
  })
}
