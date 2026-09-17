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

  // The fragment is separated off first, before anything looks for a `code`.
  // Doing it the other way round is what made the fragment branch unreachable:
  // the old guard asked whether the string still contained `code=` while that
  // string *was* the fragment, so a fragment carrying a code answered "yes" and
  // the fragment was never split off — `#code=abc&state=xyz` parsed to a key of
  // `https://app.example/cb#code`, with only `state` surviving, by accident of
  // sitting after the first `&`. It also required a `?` to be present at all,
  // so `myapp://cb#code=…` never reached the branch either. The asymmetry was
  // visible from the outside: a fragment-borne `error=` parsed fine, because
  // there was no `code=` anywhere to fool the test, while a fragment-borne
  // success did not.
  const hashIndex = trimmed.indexOf('#')
  const beforeHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : ''

  const questionMark = beforeHash.indexOf('?')

  // With no `?`, the whole thing is treated as the query — that is what makes a
  // bare `code=…&state=…` string work. A full URL with no query lands here too
  // and parses to nonsense keys, which is harmless: it yields no `code` and no
  // `error`, so the fragment below gets its turn.
  const search = questionMark >= 0 ? beforeHash.slice(questionMark + 1) : beforeHash

  // Some providers return the params in the fragment rather than the query.
  // Which half won is decided by what was actually found, not by where a `#`
  // happened to be: the query is authoritative when it carries the response,
  // and the fragment is read only when it does not.
  const fromSearch = parseQuery(search)
  const params =
    fragment && !fromSearch['code'] && !fromSearch['error'] ? parseQuery(fragment) : fromSearch
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
