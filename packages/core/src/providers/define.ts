import { OAuthError } from '../errors.js'
import { parseQuery } from '../query.js'
import type {
  CallbackParseResult,
  CallbackResult,
  ProviderConfig,
  ProviderInput,
} from '../types.js'

/**
 * Default callback parser: accepts a full redirect URL, a bare query string, or
 * a `?`-prefixed fragment, and pulls out the standard OAuth params.
 */
export function parseStandardCallback(input: string): CallbackParseResult {
  const trimmed = input.trim()
  let query = trimmed

  const questionMark = trimmed.indexOf('?')

  if (questionMark >= 0) {
    query = trimmed.slice(questionMark + 1)
  } else if (trimmed.startsWith('#')) {
    query = trimmed.slice(1)
  }

  /*
   * Some providers return the params in the fragment rather than the query, so
   * a URL carrying both has to be told apart from one carrying only a fragment
   * response. The decision is made on the part *before* the `#`, which is the
   * only part that is a query string at all.
   *
   * It used to be made on the whole remainder, fragment included, which was
   * wrong in three ways at once. `?code=A&state=B#frag` kept the query — right
   * answer — but left the fragment glued on, so `state` came back as `B#frag`
   * and failed the comparison. `?error=access_denied&state=S#z` contains no
   * `code=`, so the query was thrown away in favour of a fragment that holds
   * nothing, and the denial vanished into `{}` — a login that hangs instead of
   * reporting why it failed. And `?state=S#code=A` matched `code=` in the
   * fragment while the test was meant to be about the query, so the query won
   * and the code was never found.
   *
   * All three fail closed, so this is robustness rather than a hole. The rule
   * now: if the query part carries a `code` or an `error` parameter it is the
   * response and the fragment is discarded; otherwise the fragment is. The
   * pattern anchors on `^` or `&` so `authorization_code=…` or
   * `error_description=…` cannot pass for the parameter itself.
   *
   * A pure fragment response — `https://app/cb#code=X&state=Y`, with no query —
   * has no `code`/`error` before the `#` and so takes the fragment, which is
   * the same answer it got before.
   */
  const hashIndex = query.indexOf('#')

  if (hashIndex >= 0) {
    const beforeHash = query.slice(0, hashIndex)
    query = /(^|&)(code|error)=/.test(beforeHash) ? beforeHash : query.slice(hashIndex + 1)
  }

  const params = parseQuery(query)
  const result: CallbackParseResult = {}
  const code = params['code']
  const state = params['state']
  const error = params['error']
  const errorDescription = params['error_description']

  if (code) {
    result.code = code
  }

  if (state) {
    result.state = state
  }

  if (error) {
    result.error = error
  }

  if (errorDescription) {
    result.errorDescription = errorDescription
  }

  return result
}

/**
 * Reads a provider's callback into a {@link CallbackResult}, or throws the
 * `authorization_denied` error it represents.
 *
 * Every receiver needs exactly this — pick the provider's parser, treat `error=`
 * or a missing code as a failure, otherwise hand back `code`/`state` — so it
 * lives here once instead of being reimplemented per platform.
 */
export function readCallback(provider: ProviderConfig, input: string): CallbackResult {
  const parse = provider.parseCallback ?? parseStandardCallback
  const parsed = parse(input)

  if (parsed.error || !parsed.code) {
    throw new OAuthError(
      'authorization_denied',
      `Authorization failed: ${parsed.errorDescription ?? parsed.error ?? 'no code returned'}`,
      {
        ...(parsed.error ? { providerError: parsed.error } : {}),
        ...(parsed.errorDescription ? { providerErrorDescription: parsed.errorDescription } : {}),
        ...(parsed.state ? { state: parsed.state } : {}),
      },
    )
  }

  return { code: parsed.code, ...(parsed.state ? { state: parsed.state } : {}) }
}

/**
 * Fills in the defaults that almost every provider shares, so a descriptor only
 * has to state what makes it different.
 */
export function defineProvider(input: ProviderInput): ProviderConfig {
  return {
    usePkce: true,
    pkceMethod: 'S256',
    tokenRequest: { style: 'form', includeClientIdInBody: true },
    ...input,
    redirect: { loopbackPath: '/callback', loopbackHost: 'localhost', ...input.redirect },
  }
}
