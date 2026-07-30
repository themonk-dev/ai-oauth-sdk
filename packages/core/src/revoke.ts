import { OAuthError } from './errors.js'
import { encodeQuery } from './query.js'
import { fetchWithSignal } from './http.js'
import type { FetchLike, ProviderConfig, TokenSet } from './types.js'

export type RevocableTokenType = 'access_token' | 'refresh_token'

export interface RevokeTokenInput {
  provider: ProviderConfig
  clientId: string
  tokens: TokenSet
  /** Which token to revoke. Default `refresh_token` — it kills the session. */
  tokenType?: RevocableTokenType
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/**
 * RFC 7009 token revocation.
 *
 * Revoking the *refresh* token is what actually ends a session; revoking only
 * the access token leaves the client able to mint a new one. Most providers
 * cascade from refresh to access, which is why that is the default.
 *
 * Per the RFC an unknown or already-revoked token is still a success — the
 * desired end state (that token does not work) holds either way.
 */
export async function revokeToken(input: RevokeTokenInput): Promise<void> {
  const { provider, tokens } = input
  if (!provider.revocationUrl) {
    throw new OAuthError(
      'configuration_error',
      `Provider "${provider.id}" does not declare a revocation endpoint. ` +
        'Clearing local tokens with logout() is the only option.',
    )
  }

  const tokenType = input.tokenType ?? 'refresh_token'
  const token = tokenType === 'refresh_token' ? tokens.refreshToken : tokens.accessToken
  if (!token) {
    throw new OAuthError('configuration_error', `No ${tokenType} available to revoke.`)
  }

  const body: Record<string, string> = {
    token,
    token_type_hint: tokenType,
    client_id: input.clientId,
  }
  if (provider.clientSecret) {
    body['client_secret'] = provider.clientSecret
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const response = await fetchWithSignal(
    fetchImpl,
    provider.revocationUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeQuery(body),
    },
    input.signal,
    'Revocation request was aborted.',
  )

  // 200 is the specified success. 400 with `unsupported_token_type` or an
  // unknown token is also terminal, and retrying will not help.
  if (!response.ok && response.status !== 400) {
    throw new OAuthError(
      'token_request_failed',
      `Revocation failed (HTTP ${response.status}).`,
      { status: response.status },
    )
  }
}
