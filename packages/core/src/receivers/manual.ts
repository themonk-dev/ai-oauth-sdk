import { buildLoopbackRedirectUri, defaultRedirectUri } from '../authorize.js'
import { OAuthError } from '../errors.js'
import { parseStandardCallback } from '../providers/define.js'
import type { CallbackReceiver, CallbackResult, ReceiverContext } from '../types.js'

/** Port used when a loopback provider accepts any, since nothing will listen. */
const PASTE_FALLBACK_PORT = 1455

export interface ManualReceiverOptions {
  /**
   * Shows the authorization URL and returns whatever the user pastes back —
   * a full redirect URL, a bare code, or Claude's `code#state`.
   */
  prompt: (url: string, context: ReceiverContext) => Promise<string>
  /** Fixed redirect URI. Defaults to whatever the provider's mode implies. */
  redirectUri?: string
}

/**
 * The redirect URI to hand the provider when the caller named none.
 *
 * A hosted provider publishes one. A loopback provider does not — but pasting
 * still works there: the browser fails to reach the port, and the user copies
 * the code straight out of the address bar. So a loopback URI is synthesised
 * rather than refused, including for providers that accept any port (`0`),
 * where nothing is listening anyway and the value only has to round-trip
 * unchanged into the token request.
 *
 * A hosted URI wins even for a loopback provider. Pasting needs a page that
 * *shows* the user a code, and that is exactly what a hosted callback is;
 * sending them to a loopback URI nothing is listening on shows a connection
 * error and asks them to read the address bar instead.
 */
function resolveRedirectUri(context: ReceiverContext): string | undefined {
  const { provider } = context

  if (provider.redirect.hostedUri) {
    return provider.redirect.hostedUri
  }

  const declared = defaultRedirectUri(provider)

  if (declared) {
    return declared
  }

  if (provider.redirect.mode === 'loopback') {
    return buildLoopbackRedirectUri(provider, PASTE_FALLBACK_PORT)
  }

  return undefined
}

/**
 * The universal fallback: no server, no browser integration, no deep links.
 *
 * Works on headless boxes, over SSH, inside containers, and in any runtime at
 * all — the caller owns how the URL is shown and how the response is collected.
 *
 * The prompt both displays the URL and collects the reply, so `present()` kicks
 * it off and `wait()` awaits the same promise. That promise gets a no-op
 * `catch` because `wait()` may never be called — the caller gives up, or
 * another receiver wins a race — and a rejection would otherwise surface as an
 * unhandled one. `wait()` still sees it.
 */
export function manualReceiver(options: ManualReceiverOptions): CallbackReceiver {
  return {
    id: 'manual',
    async start(context) {
      const redirectUri = options.redirectUri ?? resolveRedirectUri(context)

      if (!redirectUri) {
        throw new OAuthError(
          'configuration_error',
          `Provider "${context.provider.id}" does not use a redirect, so it cannot ` +
            'be completed by pasting. Use the device-code flow instead ' +
            '(`deviceLogin()`, or `--device` on the CLI).',
        )
      }

      let pending: Promise<CallbackResult> | undefined

      return {
        redirectUri,
        async present(url) {
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
