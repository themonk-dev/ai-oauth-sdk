import { OAuthError } from './errors.js'
import { encodeQuery } from './query.js'
import { fetchWithSignal } from './http.js'
import { safeSnippet } from './redact.js'
import type { FetchLike, ProviderConfig, TokenSet } from './types.js'

/** Renew this many ms before the real expiry, to absorb clock skew and latency. */
export const DEFAULT_EXPIRY_SKEW_MS = 60_000

interface TokenEndpointResponse {
  access_token?: string
  refresh_token?: string
  /** Spec says a number; some providers send the digits as a JSON string. */
  expires_in?: number | string
  token_type?: string
  scope?: string
  id_token?: string
  error?: string
  error_description?: string
  [key: string]: unknown
}

/**
 * Pulls a printable error out of a token response.
 *
 * The spec says `error` and `error_description` are strings. Providers disagree:
 * OpenAI nests `{"error":{"message":…,"type":…,"code":…}}`, and some gateways
 * return `{"detail":"…"}`. Anything that is not a string is unwrapped where we
 * recognise the shape and dropped otherwise, so the caller falls back to a
 * snippet of the raw body rather than printing `[object Object]`.
 *
 * Every extracted string goes through {@link safeSnippet}. These fields come
 * from the provider, not from us: a gateway that reflects the request would
 * otherwise put a live `refresh_token` into the error message, and SECURITY.md
 * requires anything quoted out of a response to be redacted first.
 */
function readTokenError(parsed: TokenEndpointResponse): {
  error?: string
  description?: string
} {
  const asString = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) {
      return undefined
    }

    return safeSnippet(value)
  }

  const nested = typeof parsed.error === 'object' && parsed.error !== null
    ? (parsed.error as Record<string, unknown>)
    : undefined

  return {
    error: asString(parsed.error) ?? asString(nested?.['type']) ?? asString(nested?.['code']),
    description:
      asString(parsed.error_description) ??
      asString(nested?.['message']) ??
      asString(parsed['detail']),
  }
}

function encodeBody(params: Record<string, string>, style: 'form' | 'json'): {
  body: string
  contentType: string
} {
  if (style === 'json') {
    return { body: JSON.stringify(params), contentType: 'application/json' }
  }

  return { body: encodeQuery(params), contentType: 'application/x-www-form-urlencoded' }
}

/**
 * Posts to the token endpoint and returns the parsed body.
 *
 * A provider's `parseTokenResponse` runs before the error check, because one
 * with a non-standard success shape may also report errors differently.
 */
async function postToTokenEndpoint(
  provider: ProviderConfig,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<TokenEndpointResponse> {
  const { body, contentType } = encodeBody(params, provider.tokenRequest.style)

  const response = await fetchWithSignal(
    fetchImpl,
    provider.tokenUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Accept: 'application/json',
        ...provider.tokenRequest.headers,
      },
      body,
    },
    signal,
    'Token request was aborted.',
  )

  const text = await response.text()
  let parsed: TokenEndpointResponse

  try {
    parsed = text ? (JSON.parse(text) as TokenEndpointResponse) : {}
  } catch {
    throw new OAuthError(
      'invalid_token_response',
      `Token endpoint returned a non-JSON body (HTTP ${response.status}): ${safeSnippet(text)}`,
      { status: response.status },
    )
  }

  if (provider.parseTokenResponse && response.ok) {
    parsed = provider.parseTokenResponse(parsed as Record<string, unknown>) as TokenEndpointResponse
  }

  if (!response.ok || parsed.error) {
    const { error, description } = readTokenError(parsed)
    const detail = description ?? error ?? safeSnippet(text)
    throw new OAuthError(
      'token_request_failed',
      `Token request to ${provider.tokenUrl} failed (HTTP ${response.status}): ${detail}`,
      {
        status: response.status,
        ...(error ? { providerError: error } : {}),
        ...(description ? { providerErrorDescription: description } : {}),
      },
    )
  }

  return parsed
}

/**
 * The lifetime in seconds, or undefined when the response does not state one.
 *
 * RFC 6749 §5.1 says `expires_in` is a number, and a well-known
 * non-conformance is to send the digits as a JSON string instead. Rejecting
 * `"3600"` costs more than accepting it: with no `expiresAt`, {@link isExpired}
 * answers false forever, so the credential is never renewed ahead of its real
 * expiry. Anything that is not a finite, non-negative number after coercion —
 * `null`, `"soon"`, `-1`, `Infinity` — states nothing usable and is dropped.
 */
function readExpiresIn(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const seconds = Number(value)

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/**
 * Shapes a token endpoint response into a {@link TokenSet}.
 *
 * `previous` carries a renewal's omissions forward. Providers commonly leave
 * `refresh_token` out of a refresh response, and identity fields with it, so
 * dropping either would quietly downgrade the stored credential.
 */
function toTokenSet(
  provider: ProviderConfig,
  raw: TokenEndpointResponse,
  previous?: TokenSet,
): TokenSet {
  const accessToken = raw.access_token

  if (typeof accessToken !== 'string' || !accessToken) {
    throw new OAuthError(
      'invalid_token_response',
      `Token endpoint response for "${provider.id}" did not include an access_token.`,
    )
  }

  // Validate before choosing, the way `access_token` is checked above. A
  // gateway that always emits the field sends `"refresh_token": ""` on a
  // renewal; testing the whole `??` expression for truthiness dropped both the
  // empty string and the stored token with it, and the next refresh then failed
  // with `refresh_failed` for a session that was still perfectly renewable.
  const refreshToken =
    typeof raw.refresh_token === 'string' && raw.refresh_token
      ? raw.refresh_token
      : previous?.refreshToken
  const expiresIn = readExpiresIn(raw.expires_in)

  const tokens: TokenSet = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    tokenType: raw.token_type ?? 'Bearer',
    ...(raw.scope ? { scope: raw.scope } : {}),
    ...(raw.id_token ? { idToken: raw.id_token } : {}),
    provider: provider.id,
    raw: raw as Record<string, unknown>,
  }

  const enriched = provider.enrichTokens?.(raw as Record<string, unknown>, tokens)
  const merged = enriched ? { ...tokens, ...enriched } : tokens

  if (!merged.accountId && previous?.accountId) {
    merged.accountId = previous.accountId
  }

  if (!merged.email && previous?.email) {
    merged.email = previous.email
  }

  return merged
}

export interface ExchangeCodeInput {
  provider: ProviderConfig
  clientId: string
  code: string
  redirectUri: string
  codeVerifier?: string
  state?: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/**
 * Trades an authorization code for tokens.
 *
 * `state` belongs to the authorization request, not this one, so it is sent
 * only where a provider opts in. Claude accepts it here too, which is why it
 * was once sent unconditionally — but OpenAI rejects the whole exchange with
 * "Unknown parameter: 'state'".
 */
export async function exchangeCode(input: ExchangeCodeInput): Promise<TokenSet> {
  const { provider } = input
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    ...provider.tokenRequest.extraParams,
  }

  if (provider.tokenRequest.includeClientIdInBody !== false) {
    params['client_id'] = input.clientId
  }

  if (provider.clientSecret) {
    params['client_secret'] = provider.clientSecret
  }

  if (input.codeVerifier) {
    params['code_verifier'] = input.codeVerifier
  }

  if (input.state && provider.tokenRequest.includeState) {
    params['state'] = input.state
  }

  const raw = await postToTokenEndpoint(
    provider,
    params,
    input.fetchImpl ?? globalThis.fetch,
    input.signal,
  )

  return toTokenSet(provider, raw)
}

export interface RefreshTokensInput {
  provider: ProviderConfig
  clientId: string
  tokens: TokenSet
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

export async function refreshTokens(input: RefreshTokensInput): Promise<TokenSet> {
  const { provider, tokens } = input

  if (!tokens.refreshToken) {
    throw new OAuthError(
      'refresh_failed',
      `No refresh token available for "${provider.id}". Re-run the login flow.`,
    )
  }

  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    ...provider.tokenRequest.extraParams,
  }

  if (provider.tokenRequest.includeClientIdInBody !== false) {
    params['client_id'] = input.clientId
  }

  if (provider.clientSecret) {
    params['client_secret'] = provider.clientSecret
  }

  if (tokens.scope) {
    params['scope'] = tokens.scope
  }

  try {
    const raw = await postToTokenEndpoint(
      provider,
      params,
      input.fetchImpl ?? globalThis.fetch,
      input.signal,
    )

    return toTokenSet(provider, raw, tokens)
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'token_request_failed') {
      throw new OAuthError('refresh_failed', `Refresh failed for "${provider.id}": ${error.message}`, {
        cause: error,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.providerError ? { providerError: error.providerError } : {}),
      })
    }

    throw error
  }
}

/** True when the token is missing, expired, or inside the renewal skew window. */
export function isExpired(tokens: TokenSet | undefined, skewMs = DEFAULT_EXPIRY_SKEW_MS): boolean {
  if (!tokens) {
    return true
  }

  if (tokens.expiresAt === undefined) {
    return false
  }

  return Date.now() >= tokens.expiresAt - skewMs
}
