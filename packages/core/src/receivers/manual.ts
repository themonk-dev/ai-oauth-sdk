import { buildLoopbackRedirectUri, defaultRedirectUri } from '../authorize.js'
import { isOAuthError, OAuthError } from '../errors.js'
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
  /**
   * Asked whether to run `prompt()` again when a paste could not be turned into
   * a code, with the error that would otherwise reach `wait()` and the number of
   * attempts made so far. Returning false rethrows it.
   *
   * Opt-in, and deliberately so: without it one paste is one answer, which is
   * the only safe default here. A retry loop is only escapable when something
   * other than the user can end it — a receiver racing this one, or an abort
   * signal `prompt()` honours. Supplied where neither exists, it turns a
   * mistyped paste into a login that can only be left with Ctrl-C.
   *
   * A `prompt()` that rejects is not a rejected paste and is never retried:
   * that is how the abort gets out.
   */
  retry?: (error: OAuthError, attempts: number) => boolean | Promise<boolean>
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
 *
 * One paste is one answer unless a `retry` is supplied: a value that cannot be
 * parsed rejects `wait()` and the caller decides what happens next. See the
 * option for why asking again is the opt-in rather than the default.
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

      /** One pasted value, turned into a result or into the reason it is not one. */
      const parsePaste = (input: string): CallbackResult => {
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
      }

      /**
       * Asks until a paste parses, or until `retry` — absent by default — says
       * to stop.
       *
       * Only a paste that failed to *parse* is retried. A `prompt()` that
       * rejects has not produced an answer to reject: it is the read being
       * abandoned, by an abort signal or a stdin that ended, and reopening it
       * would be how a race that this half already lost never finishes.
       */
      const collect = async (url: string): Promise<CallbackResult> => {
        for (let attempts = 1; ; attempts++) {
          const input = await options.prompt(url, context)

          try {
            return parsePaste(input)
          } catch (error) {
            if (
              !options.retry ||
              !isOAuthError(error) ||
              !(await options.retry(error, attempts))
            ) {
              throw error
            }
          }
        }
      }

      return {
        redirectUri,
        async present(url) {
          const collected = collect(url)
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
