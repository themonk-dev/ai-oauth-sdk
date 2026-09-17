import { OAuthError } from './errors.js'
import { fetchWithSignal } from './http.js'
import { appendQuery, parseQuery } from './query.js'
import { DEFAULT_EXPIRY_SKEW_MS } from './token.js'
import type { AuthClient } from './client.js'
import type { FetchLike, ResolvedCredential, TokenSet } from './types.js'

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
  /**
   * Extra headers merged into every request.
   *
   * Beats anything the provider supplies, so this is where you override a
   * default like Copilot's `Editor-Version`. A header set on the request itself
   * still wins over both.
   */
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

  const resolveUrl = (input: string, baseUrl: string | undefined): string => {
    if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
      return input
    }

    return `${baseUrl.replace(/\/$/, '')}/${input.replace(/^\//, '')}`
  }

  let cached:
    | { credential: ResolvedCredential; expiresAt: number; source: string }
    | undefined

  /**
   * Resolves the stored token into the credential the API takes.
   *
   * Cached until shortly before it expires, because for GitHub Copilot this is
   * a network round trip and the result lives about 25 minutes. `discard`
   * throws the cache away, which is what the 401 retry wants: an exchanged
   * credential can be revoked before its nominal expiry just like any other.
   *
   * `source` is the stored token the credential was derived from, and the cache
   * is only read when it still matches. This `fetch` is meant to be built once
   * and kept — the client underneath it is not. A `logout()` followed by a
   * second `login()` puts a different account's token in the same storage and
   * tells this closure nothing, so without the check the new account's requests
   * would go out bearing the previous account's credential, and to the host
   * that account's exchange named, for the credential's full lifetime. Nothing
   * self-heals it: the credential is still entirely valid, so no 401 arrives.
   */
  const resolveCredential = async (
    tokens: TokenSet | undefined,
    accessToken: string,
    discard: boolean,
  ): Promise<ResolvedCredential> => {
    const { exchangeCredential } = client.provider

    if (!exchangeCredential || !tokens) {
      return { accessToken, ...(tokens?.tokenType ? { tokenType: tokens.tokenType } : {}) }
    }

    if (discard) {
      cached = undefined
    }

    if (
      cached &&
      cached.source === tokens.accessToken &&
      Date.now() < cached.expiresAt - DEFAULT_EXPIRY_SKEW_MS
    ) {
      return cached.credential
    }

    const credential = await exchangeCredential(tokens, { fetch: fetchImpl })
    cached =
      credential.expiresAt === undefined
        ? undefined
        : { credential, expiresAt: credential.expiresAt, source: tokens.accessToken }

    return credential
  }

  /**
   * Merges the provider's query parameters into a URL, letting anything the URL
   * already carries win so a caller can still override a provider default per
   * request.
   *
   * Done with the string helpers in `query.ts` rather than `URL`, for the
   * reason that module exists at all: React Native's built-in URL shim
   * implements the constructor and `toString` but *throws* from `searchParams`
   * and `pathname`. Reading either here would have made every authenticated
   * request fail on bare Hermes before it was sent — and not hypothetically,
   * since the early return below only spares providers that contribute no
   * parameters, and OpenAI's `apiQuery` contributes `client_version` to every
   * single request. Splitting on `#` and `?` needs none of that, and works the
   * same on a relative path as on an absolute URL, which the `URL` version had
   * to special-case with a placeholder origin.
   *
   * The existing parameters are enumerated *first* and the provider's appended
   * after, because object key order is what `encodeQuery` serialises in and the
   * URL's own parameters came first before. `{ ...query, ...parseQuery(existing) }`
   * would produce the same set in the wrong order.
   */
  const applyQuery = (url: string, query: Record<string, string>): string => {
    if (Object.keys(query).length === 0) {
      return url
    }

    const withoutFragment = url.split('#')[0] ?? ''
    const queryAt = withoutFragment.indexOf('?')
    const existing = queryAt === -1 ? '' : withoutFragment.slice(queryAt + 1)

    const merged = parseQuery(existing)

    for (const [key, value] of Object.entries(query)) {
      if (!(key in merged)) {
        merged[key] = value
      }
    }

    // `appendQuery` re-reads the same existing parameters and overwrites them
    // with these, which for every key is the value it already had — so this
    // hands off the base/query/fragment splitting rather than repeating it.
    return appendQuery(url, merged)
  }

  /**
   * Builds the URL, headers and body for one attempt. All three can depend on
   * the credential, so they are resolved together and rebuilt from scratch on
   * the 401 retry rather than carried over.
   *
   * `retry` is the second attempt. What that means depends on the provider: one
   * that exchanges its credential should re-run the exchange, since its
   * short-lived API token is the thing that most likely went stale, while one
   * that sends the stored token directly should refresh that instead. Doing
   * both would refresh a perfectly good OAuth token to fix an expired exchange,
   * and for Copilot in particular the stored token has no expiry to renew.
   */
  const prepare = async (input: string, init: RequestInit | undefined, retry: boolean) => {
    const exchanges = client.provider.exchangeCredential !== undefined
    const forceRefresh = retry && !exchanges
    const accessToken = await client.getAccessToken(forceRefresh ? { forceRefresh: true } : {})
    const tokens = await client.getTokens()
    const credential = await resolveCredential(tokens, accessToken, retry)

    const headers = new Headers(init?.headers)

    if (!options.respectCallerAuthorization || !headers.has('Authorization')) {
      headers.set('Authorization', `${credential.tokenType ?? 'Bearer'} ${credential.accessToken}`)
    }

    // Precedence, weakest first: what the provider supplies, then what this
    // instance was configured with, then what the caller set on the request.
    // Collected through `Headers` rather than an object spread so the merge is
    // case-insensitive the way HTTP is, and `Editor-Version` from an option
    // replaces `editor-version` from a provider instead of sitting beside it.
    const defaults = new Headers()

    for (const source of [
      credential.headers,
      tokens ? client.provider.apiHeaders?.(tokens) : undefined,
      options.headers,
    ]) {
      for (const [key, value] of Object.entries(source ?? {})) {
        defaults.set(key, value)
      }
    }

    defaults.forEach((value, key) => {
      if (!headers.has(key)) {
        headers.set(key, value)
      }
    })

    // Same shape for the host: an explicit option wins, then whatever the
    // exchange named, then the descriptor's constant. Copilot only learns its
    // host from the exchange, and enterprise accounts get a different one.
    const baseUrl = options.baseUrl ?? credential.baseUrl ?? client.provider.apiBaseUrl
    const url = applyQuery(
      resolveUrl(input, baseUrl),
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
