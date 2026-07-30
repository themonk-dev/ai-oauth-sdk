import { OAuthError } from '../errors.js'
import { parseStandardCallback } from '../providers/define.js'
import type { CallbackReceiver, CallbackResult, ReceiverContext } from '../types.js'

export interface ManualReceiverOptions {
  /**
   * Shows the authorization URL and returns whatever the user pastes back —
   * a full redirect URL, a bare code, or Anthropic's `code#state`.
   */
  prompt: (url: string, context: ReceiverContext) => Promise<string>
  /** Fixed redirect URI. Defaults to the provider's hosted URI. */
  redirectUri?: string
}

/**
 * The universal fallback: no server, no browser integration, no deep links.
 *
 * Works on headless boxes, over SSH, inside containers, and in any runtime at
 * all — the caller owns how the URL is shown and how the response is collected.
 */
export function manualReceiver(options: ManualReceiverOptions): CallbackReceiver {
  return {
    id: 'manual',
    async start(context) {
      const redirectUri = options.redirectUri ?? context.provider.redirect.hostedUri
      if (!redirectUri) {
        throw new OAuthError(
          'configuration_error',
          `Provider "${context.provider.id}" has no hosted redirect URI, so ` +
            '`manualReceiver` needs an explicit `redirectUri`.',
        )
      }

      let pending: Promise<CallbackResult> | undefined

      return {
        redirectUri,
        async present(url) {
          // The prompt both displays the URL and collects the reply, so kick it
          // off here and let `wait()` await the same promise.
          const collected = options.prompt(url, context).then((input) => {
            const parse = context.provider.parseCallback ?? parseStandardCallback
            const parsed = parse(input)
            if (parsed.error) {
              throw new OAuthError(
                'authorization_denied',
                `Authorization denied: ${parsed.errorDescription ?? parsed.error}`,
                {
                  providerError: parsed.error,
                  ...(parsed.errorDescription
                    ? { providerErrorDescription: parsed.errorDescription }
                    : {}),
                },
              )
            }
            if (!parsed.code) {
              throw new OAuthError(
                'invalid_token_response',
                'Could not find an authorization code in the pasted value.',
              )
            }
            return { code: parsed.code, ...(parsed.state ? { state: parsed.state } : {}) }
          })
          // `wait()` may never be called — if the caller gives up, or a
          // different receiver wins a race — so keep a rejection here from
          // surfacing as an unhandled promise rejection. `wait()` still sees it.
          collected.catch(() => {})
          pending = collected
          await context.openUrl?.(url)
        },
        async wait() {
          if (!pending) {
            throw new OAuthError('configuration_error', 'present() must be called before wait().')
          }
          return pending
        },
        async close() {
          /* nothing to tear down */
        },
      }
    },
  }
}
