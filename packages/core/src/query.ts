/**
 * Query-string handling that avoids `URL.searchParams` and the
 * `URLSearchParams` constructor.
 *
 * Bare React Native ships a URL shim whose `searchParams` getter throws
 * outright, and a `URLSearchParams` that historically accepted only an object.
 * Building an authorization URL through either one fails before the browser
 * ever opens — so the whole OAuth path uses these instead and works on Hermes
 * with no polyfill.
 *
 * The output is byte-for-byte what `URLSearchParams` produces; `query.test.ts`
 * asserts that against the real implementation across the ASCII range, so
 * nothing on the wire changes for runtimes that do have it.
 */

/**
 * Matches one well-formed surrogate pair, or a single surrogate left on its
 * own. The pair alternative comes first so a valid astral character is claimed
 * whole and never mistaken for two strays.
 */
const SURROGATE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g

/**
 * Percent-encodes one component the way the URL standard's
 * application/x-www-form-urlencoded serialiser does.
 *
 * `encodeURIComponent` is close but not equal: it renders a space as `%20`
 * rather than `+`, and it leaves `!'()~` untouched where the form serialiser
 * escapes them. (`*` stays literal in both.)
 *
 * Lone surrogates are replaced with U+FFFD first, which is what the URL
 * standard's serialiser — and therefore `URLSearchParams` — already does with
 * them; `encodeURIComponent` instead throws a bare `URIError`. That matters
 * because `JSON.parse` passes a lone surrogate straight through, so a token
 * endpoint answering with `"refresh_token": "rt\ud800"` gets it stored
 * verbatim, and every later refresh of a `style: 'form'` provider would throw
 * a `URIError` out of the token request. `errors.ts` promises that every
 * failure this SDK produces is an `OAuthError`, and a `URIError` escaping here
 * breaks that: it sails through the `refresh_failed` wrapper untouched, so the
 * caller's documented "catch `refresh_failed`, prompt a re-login" branch never
 * runs. Substituting fails closed instead — the mangled credential is rejected
 * by the server and surfaces as an ordinary `refresh_failed`.
 */
function encodeComponent(value: string): string {
  const wellFormed = value.replace(SURROGATE, (match) => (match.length === 2 ? match : '�'))

  return encodeURIComponent(wellFormed)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Reverses {@link encodeComponent}.
 *
 * `+` means space in form encoding, which `decodeURIComponent` does not know.
 * A stray `%` is not worth throwing over — a provider that sends one still
 * deserves to have the rest of its callback read.
 */
function decodeComponent(value: string): string {
  const spaced = value.replace(/\+/g, ' ')

  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

/** Serialises params as `a=1&b=2`, ready for a query string or a form body. */
export function encodeQuery(params: Record<string, string>): string {
  const parts: string[] = []

  for (const [key, value] of Object.entries(params)) {
    parts.push(`${encodeComponent(key)}=${encodeComponent(value)}`)
  }

  return parts.join('&')
}

/**
 * Parses `a=1&b=2` into an object. A repeated key keeps its last value, which
 * is what `URLSearchParams.get` would return and all any OAuth flow needs.
 */
export function parseQuery(query: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const pair of query.split('&')) {
    if (!pair) {
      continue
    }

    const equals = pair.indexOf('=')
    const rawKey = equals === -1 ? pair : pair.slice(0, equals)
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1)
    result[decodeComponent(rawKey)] = decodeComponent(rawValue)
  }

  return result
}

/**
 * Merges `params` into a URL's query string, replacing any key already present
 * and leaving a fragment where it was.
 */
export function appendQuery(url: string, params: Record<string, string>): string {
  const hashAt = url.indexOf('#')
  const fragment = hashAt === -1 ? '' : url.slice(hashAt)
  const withoutFragment = hashAt === -1 ? url : url.slice(0, hashAt)

  const queryAt = withoutFragment.indexOf('?')
  const base = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt)
  const existing = queryAt === -1 ? '' : withoutFragment.slice(queryAt + 1)

  const query = encodeQuery({ ...parseQuery(existing), ...params })

  return query ? `${base}?${query}${fragment}` : `${base}${fragment}`
}
