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

  /* Some providers return params in the fragment rather than the query. */
  const hashIndex = query.indexOf('#')

  if (questionMark >= 0 && hashIndex >= 0 && !query.includes('code=')) {
    query = query.slice(hashIndex + 1)
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
    tokenRequest: { style: 'form', includeClientIdInBody: true },
    ...input,
    // These two sit *after* the spread because they carry the library's central
    // promise, and a promise a caller can break by accident is not one. Ahead of
    // it, a key that is present but explicitly `undefined` — what
    // `defineProvider({ ...cfg, usePkce: cfg.usePkce })` produces, and what the
    // optional types accept without a word — overwrote `true` with nothing, and
    // every later reader tests it for bare truthiness. `??` rather than `||`, so
    // the `usePkce: false` a device-flow provider means deliberately survives.
    usePkce: input.usePkce ?? true,
    pkceMethod: input.pkceMethod ?? 'S256',
    redirect: { loopbackPath: '/callback', loopbackHost: 'localhost', ...input.redirect },
  }
}
