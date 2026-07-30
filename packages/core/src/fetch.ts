import { OAuthError } from './errors.js'
import { fetchWithSignal } from './http.js'
import type { AuthClient } from './client.js'
import type { FetchLike } from './types.js'

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
}

/**
 * Whether a request body can survive being sent twice.
 *
 * Strings, buffers, `Blob`s, `URLSearchParams` and `FormData` are all
 * re-serialised on each send. A `ReadableStream` (and anything exotic enough
 * not to be recognised here) is read once and then locked.
 */
function isReplayable(body: RequestInit['body']): boolean {
  // Each global is feature-detected: not every runtime defines all of them.
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

  const buildHeaders = async (init: RequestInit | undefined, forceRefresh: boolean) => {
    const accessToken = await client.getAccessToken(forceRefresh ? { forceRefresh: true } : {})
    const tokens = await client.getTokens()

    // Start from the caller's headers so an explicit Authorization still wins.
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) {
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
    return headers
  }

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input)
    // The caller's signal may come from another realm; fetchWithSignal handles
    // that, so strip it from `init` and pass it separately.
    const { signal, ...rest } = init ?? {}

    const response = await fetchWithSignal(
      fetchImpl,
      url,
      { ...rest, headers: await buildHeaders(init, false) },
      signal ?? undefined,
    )
    if (response.status !== 401 || options.retryOnUnauthorized === false) {
      return response
    }
    // Replaying a body the first attempt already drained throws rather than
    // retrying, which would turn a recoverable 401 into a hard failure. Hand
    // the 401 back instead and let the caller decide.
    if (!isReplayable(rest.body)) {
      return response
    }

    // The body of a 401 is not interesting, but leaving it undrained leaks a
    // socket on some runtimes.
    void response.body?.cancel().catch(() => {})

    try {
      return await fetchWithSignal(
        fetchImpl,
        url,
        { ...rest, headers: await buildHeaders(init, true) },
        signal ?? undefined,
      )
    } catch (error) {
      // A failed refresh should surface the original 401's meaning, not a
      // confusing network error from the retry path.
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
