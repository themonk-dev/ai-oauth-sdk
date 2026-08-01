import { OAuthError } from './errors.js'
import { fetchWithSignal } from './http.js'
import type { AuthClient } from './client.js'
import type { FetchLike, TokenSet } from './types.js'

export interface AuthenticatedFetchOptions {
  /** Underlying fetch. Defaults to the global. */
  fetch?: FetchLike
  /**
   * Force a refresh and retry once when the API answers 401.
   *
   * A token can be revoked, or rotated by another process, well before its
   * nominal expiry — in which case our local clock says "still valid" and only
   * the 401 reveals otherwise. Default true.
   *
   * Requests with a streaming body are never retried: the stream is consumed by
   * the first attempt and cannot be replayed. Those return the 401 as-is.
   */
  retryOnUnauthorized?: boolean
  /** Prefix for relative URLs. Defaults to the provider's `apiBaseUrl`. */
  baseUrl?: string
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
  /**
   * Let an `Authorization` header on the request survive instead of replacing
   * it with the managed token. Default false.
   *
   * This defaults to off because the common wrapper — an SDK that takes a
   * `fetch` and an `apiKey` — sets `Authorization` from its own `apiKey`
   * before ever calling us. The Vercel AI SDK does exactly that, and sends the
   * header even when `apiKey` is empty or omitted, so deferring to the caller
   * silently shipped a placeholder credential while the real token was
   * refreshed and then discarded.
   */
  respectCallerAuthorization?: boolean
}

/**
 * Whether a request body can survive being sent twice.
 *
 * Strings, buffers, `Blob`s, `URLSearchParams` and `FormData` are all
 * re-serialised on each send. A `ReadableStream` (and anything exotic enough
 * not to be recognised here) is read once and then locked.
 *
 * Each global is feature-detected, because not every runtime defines them all.
 */
function isReplayable(body: RequestInit['body']): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    (typeof ArrayBuffer !== 'undefined' &&
      (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob)
  )
}

/** Origin a relative URL is parsed against so `URL` will accept it. */
const PLACEHOLDER_ORIGIN = 'http://relative.invalid'

/**
 * Applies the provider's `transformRequestBody`, when there is one and the body
 * is JSON we can read.
 *
 * A body that is not a string is left alone: it may be a stream, form data, or
 * bytes, and none of those can be rewritten without consuming or guessing at
 * them. An explicit non-JSON content type is honoured, but its absence is not
 * taken to mean the body is not JSON, because most callers omit it.
 */
function transformBody(
  provider: AuthClient['provider'],
  url: string,
  init: RequestInit | undefined,
  headers: Headers,
  tokens: TokenSet,
): RequestInit['body'] {
  const { body } = init ?? {}

  if (!provider.transformRequestBody || typeof body !== 'string') {
    return body
  }

  const contentType = headers.get('content-type')

  if (contentType && !contentType.includes('json')) {
    return body
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return body
  }

  return JSON.stringify(
    provider.transformRequestBody(url, parsed as Record<string, unknown>, tokens),
  )
}

/**
 * A `fetch` that keeps itself authenticated.
 *
 * Attaches a valid bearer token (refreshing first when needed), adds whatever
 * extra headers the provider requires, and recovers from a 401 by refreshing
 * once and replaying the request.
 *
 * ```ts
 * const api = createAuthenticatedFetch(client)
 * const response = await api('/v1/models')
 * ```
 *
 * It also drops straight into any SDK that accepts a `fetch`, which is how you
 * use an OAuth token with a client built for API keys:
 *
 * ```ts
 * const openai = createOpenAI({
 *   apiKey: 'unused', // the SDK insists on one; this fetch replaces it
 *   baseURL: client.provider.apiBaseUrl,
 *   fetch: createAuthenticatedFetch(client),
 * })
 * ```
 *
 * The caller's signal is stripped from `init` and passed separately, because it
 * may come from another realm and `fetchWithSignal` is what knows how to handle
 * that. A 401 whose body cannot be replayed is returned as-is rather than
 * throwing, which would turn a recoverable failure into a hard one; the 401's
 * own body is cancelled first, since leaving it undrained leaks a socket on
 * some runtimes. If the retry's refresh fails, the error is rewritten to say so
 * — the original 401 is the useful diagnosis, not a network error from the
 * retry path.
 */
export function createAuthenticatedFetch(
  client: AuthClient,
  options: AuthenticatedFetchOptions = {},
): FetchLike {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const baseUrl = options.baseUrl ?? client.provider.apiBaseUrl

  const resolveUrl = (input: string): string => {
    if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
      return input
    }

    return `${baseUrl.replace(/\/$/, '')}/${input.replace(/^\//, '')}`
  }

  /**
   * Parsed against a placeholder origin so a relative URL survives, then
   * serialised back in whichever form it arrived as. Anything the URL already
   * carries wins, so a caller can still override a provider default per request.
   */
  const applyQuery = (url: string, query: Record<string, string>): string => {
    if (Object.keys(query).length === 0) {
      return url
    }

    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url)
    const parsed = new URL(url, absolute ? undefined : PLACEHOLDER_ORIGIN)

    for (const [key, value] of Object.entries(query)) {
      if (!parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, value)
      }
    }

    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
  }

  /**
   * Builds the URL, headers and body for one attempt. All three can depend on
   * the token set, so they are resolved together and rebuilt from scratch on
   * the 401 retry rather than carried over.
   */
  const prepare = async (input: string, init: RequestInit | undefined, forceRefresh: boolean) => {
    const accessToken = await client.getAccessToken(forceRefresh ? { forceRefresh: true } : {})
    const tokens = await client.getTokens()

    const headers = new Headers(init?.headers)

    if (!options.respectCallerAuthorization || !headers.has('Authorization')) {
      headers.set('Authorization', `${tokens?.tokenType ?? 'Bearer'} ${accessToken}`)
    }

    if (tokens) {
      for (const [key, value] of Object.entries(client.provider.apiHeaders?.(tokens) ?? {})) {
        if (!headers.has(key)) {
          headers.set(key, value)
        }
      }
    }

    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (!headers.has(key)) {
        headers.set(key, value)
      }
    }

    const url = applyQuery(
      resolveUrl(input),
      tokens ? (client.provider.apiQuery?.(tokens) ?? {}) : {},
    )
    const body = tokens ? transformBody(client.provider, url, init, headers, tokens) : init?.body

    return { url, headers, body }
  }

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const { signal, ...rest } = init ?? {}
    const first = await prepare(input, init, false)

    const response = await fetchWithSignal(
      fetchImpl,
      first.url,
      { ...rest, headers: first.headers, body: first.body },
      signal ?? undefined,
    )

    if (response.status !== 401 || options.retryOnUnauthorized === false) {
      return response
    }

    if (!isReplayable(rest.body)) {
      return response
    }

    void response.body?.cancel().catch(() => {})

    const url = first.url

    try {
      const retry = await prepare(input, init, true)

      return await fetchWithSignal(
        fetchImpl,
        retry.url,
        { ...rest, headers: retry.headers, body: retry.body },
        signal ?? undefined,
      )
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'refresh_failed') {
        throw new OAuthError(
          'refresh_failed',
          `Request to ${url} returned 401 and the token could not be refreshed. ` +
            'Re-run the login flow.',
          { cause: error, status: 401 },
        )
      }

      throw error
    }
  }
}

export interface UserInfo {
  sub?: string
  email?: string
  name?: string
  picture?: string
  [key: string]: unknown
}

/**
 * Calls the provider's OIDC userinfo endpoint.
 *
 * Only some providers expose one — `TokenSet.email`/`accountId` already cover
 * the common case without a network round-trip.
 */
export async function fetchUserInfo(
  client: AuthClient,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<UserInfo> {
  const { userInfoUrl } = client.provider

  if (!userInfoUrl) {
    throw new OAuthError(
      'configuration_error',
      `Provider "${client.provider.id}" does not declare a userinfo endpoint.`,
    )
  }

  const authenticatedFetch = createAuthenticatedFetch(client, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const response = await authenticatedFetch(userInfoUrl, {
    headers: { Accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) {
    throw new OAuthError(
      'token_request_failed',
      `Userinfo request failed (HTTP ${response.status}).`,
      { status: response.status },
    )
  }

  return (await response.json()) as UserInfo
}
