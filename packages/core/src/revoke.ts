import { OAuthError } from './errors.js'
import { encodeQuery } from './query.js'
import { fetchWithSignal } from './http.js'
import type { FetchLike, ProviderConfig, TokenSet } from './types.js'

export type RevocableTokenType = 'access_token' | 'refresh_token'

export interface RevokeTokenInput {
  provider: ProviderConfig
  clientId: string
  tokens: TokenSet
  /**
   * Which token to revoke. Defaults to `refresh_token` when the set carries
   * one — it kills the session — and to `access_token` when it does not.
   */
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
 * Where there is no refresh token the access token is revoked instead, rather
 * than nothing being sent. RFC 7009 §2.1 lets a client revoke either type and
 * makes `token_type_hint` optional, so this is a request the provider is
 * obliged to understand. It is the weaker of the two — it ends only this
 * credential, and a session the provider still considers live can be resumed by
 * anything else holding a refresh token — but a bounded revocation is the whole
 * of what such a set can ask for, and it is unambiguously better than the
 * silent no-op this used to be: the caller was told the session was over while
 * a live bearer token stayed live for the rest of its lifetime. The preference
 * never runs the other way. A set holding both revokes the refresh token, since
 * providers cascade downward and not upward.
 *
 * Per the RFC an unknown or already-revoked token is still a success — the
 * desired end state (that token does not work) holds either way. HTTP 400 is
 * accepted for the same reason: `unsupported_token_type` and an unknown token
 * are both terminal, and retrying will not help.
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

  const tokenType: RevocableTokenType =
    input.tokenType ?? (tokens.refreshToken ? 'refresh_token' : 'access_token')
  const token = tokenType === 'refresh_token' ? tokens.refreshToken : tokens.accessToken

  if (!token) {
    // Reachable two ways, and they deserve different answers. An explicit
    // `tokenType` the set cannot satisfy is a caller mistake worth naming;
    // otherwise the fallback above has already looked at both, so the set
    // simply holds nothing revocable.
    throw new OAuthError(
      'configuration_error',
      input.tokenType
        ? `No ${tokenType} available to revoke.`
        : 'This session carries neither an access token nor a refresh token, ' +
          'so there is nothing to revoke.',
    )
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

  if (!response.ok && response.status !== 400) {
    throw new OAuthError(
      'token_request_failed',
      `Revocation failed (HTTP ${response.status}).`,
      { status: response.status },
    )
  }
}
