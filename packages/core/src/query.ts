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
 * Percent-encodes one component the way the URL standard's
 * application/x-www-form-urlencoded serialiser does.
 *
 * `encodeURIComponent` is close but not equal: it renders a space as `%20`
 * rather than `+`, and it leaves `!'()~` untouched where the form serialiser
 * escapes them. (`*` stays literal in both.)
 */
function encodeComponent(value: string): string {
  return encodeURIComponent(value)
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
