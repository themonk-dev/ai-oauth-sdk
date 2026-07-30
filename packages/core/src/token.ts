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
  expires_in?: number
  token_type?: string
  scope?: string
  id_token?: string
  error?: string
  error_description?: string
  [key: string]: unknown
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

  // Normalize before the error check: a provider with a non-standard success
  // shape may also report errors differently.
  if (provider.parseTokenResponse && response.ok) {
    parsed = provider.parseTokenResponse(parsed as Record<string, unknown>) as TokenEndpointResponse
  }

  if (!response.ok || parsed.error) {
    const detail = parsed.error_description ?? parsed.error ?? safeSnippet(text)
    throw new OAuthError(
      'token_request_failed',
      `Token request to ${provider.tokenUrl} failed (HTTP ${response.status}): ${detail}`,
      {
        status: response.status,
        ...(parsed.error ? { providerError: parsed.error } : {}),
        ...(parsed.error_description ? { providerErrorDescription: parsed.error_description } : {}),
      },
    )
  }

  return parsed
}

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

  const tokens: TokenSet = {
    accessToken,
    // Providers commonly omit refresh_token on renewal; keep the existing one.
    ...(raw.refresh_token ?? previous?.refreshToken
      ? { refreshToken: raw.refresh_token ?? previous?.refreshToken }
      : {}),
    ...(typeof raw.expires_in === 'number'
      ? { expiresAt: Date.now() + raw.expires_in * 1000 }
      : {}),
    tokenType: raw.token_type ?? 'Bearer',
    ...(raw.scope ? { scope: raw.scope } : {}),
    ...(raw.id_token ? { idToken: raw.id_token } : {}),
    provider: provider.id,
    raw: raw as Record<string, unknown>,
  }

  const enriched = provider.enrichTokens?.(raw as Record<string, unknown>, tokens)
  const merged = enriched ? { ...tokens, ...enriched } : tokens
  // Carry identity forward when a refresh response omits it.
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
  // Anthropic validates `state` on the token request as well as the redirect.
  if (input.state) {
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
