import { buildLoopbackRedirectUri, defaultRedirectUri } from '../authorize.js'
import { OAuthError } from '../errors.js'
import { parseStandardCallback } from '../providers/define.js'
import type { CallbackReceiver, CallbackResult, ReceiverContext } from '../types.js'

/**
 * Port used when a loopback provider accepts any, since nothing will listen.
 *
 * It must collide with no `loopbackPort` any provider declares (`openai` 1455,
 * `xai` 56121) and with nothing else likely to be running: the browser still
 * *sends* the redirect, carrying `?code=…&state=…`, so whatever holds the port
 * reads the authorization code. This value used to be 1455 — the port this SDK
 * itself publishes for `openai` and the one the Codex CLI binds — which handed
 * every gemini / openrouter / azure-ai / custom paste login's code to an
 * unrelated local process. PKCE keeps such a code from being redeemable, so
 * what is at stake is its confidentiality, but there is no reason to spend it.
 *
 * Hence the IANA dynamic range, which is registered to nobody. Any replacement
 * has to keep both properties.
 */
const PASTE_FALLBACK_PORT = 49_713

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
 * where the value only has to round-trip unchanged into the token request —
 * which is why {@link PASTE_FALLBACK_PORT} is chosen to be one nothing else
 * answers on, rather than an arbitrary one.
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
