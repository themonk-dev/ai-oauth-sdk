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
 * 400 payloads that mean "that token is not a thing", which is the outcome we
 * were after. Every other §2.2.1 code means revocation did not happen.
 */
const REVOKED_ANYWAY = new Set(['invalid_token'])

/**
 * RFC 7009 token revocation.
 *
 * Revoking the *refresh* token is what actually ends a session; revoking only
 * the access token leaves the client able to mint a new one. Most providers
 * cascade from refresh to access, which is why that is the default.
 *
 * Per RFC 7009 §2.2 an unknown or already-revoked token is still a success —
 * the desired end state (that token does not work) holds either way, and the
 * server is required to answer 200 for it.
 *
 * A 400 is a different thing entirely. Every code §2.2.1 defines for one
 * (`invalid_request`, `invalid_client`, `unauthorized_client`,
 * `unsupported_token_type`) says the revocation did *not* happen;
 * `unsupported_token_type` says so most plainly, as it means the server
 * refuses to revoke tokens of this type and the credential is still live.
 * Treating the whole status as success made an unrevoked session look revoked.
 *
 * It cannot be a blanket rejection either. Google's endpoint — which
 * `providers/gemini.ts` declares, so this is the bundled path, not a
 * hypothetical one — answers `400 {"error": "invalid_token"}` for a token it
 * does not know, exactly the case the RFC says is a success. So the body
 * decides: a 400 carrying no `error`, or `invalid_token`, is the
 * already-revoked case and resolves; anything else throws. A body that is not
 * JSON, or not readable at all, keeps the old leniency rather than inventing a
 * failure out of a parse error.
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

  if (response.ok) {
    return
  }

  if (response.status === 400 && (await revokedAnyway(response))) {
    return
  }

  throw new OAuthError(
    'token_request_failed',
    `Revocation failed (HTTP ${response.status}).`,
    { status: response.status },
  )
}

/**
 * Decides whether a 400 describes a token that is already gone.
 *
 * Deliberately lenient about the shape: an unparseable or empty body tells us
 * nothing, and a server that sends one is no reason to start reporting a
 * failure this function used to accept. Only a body that names a code we can
 * read, and that is not `invalid_token`, is treated as a live token.
 */
async function revokedAnyway(response: Response): Promise<boolean> {
  const text = await response.text().catch(() => '')

  if (!text.trim()) {
    return true
  }

  let payload: unknown

  try {
    payload = JSON.parse(text)
  } catch {
    return true
  }

  if (typeof payload !== 'object' || payload === null) {
    return true
  }

  const error = (payload as { error?: unknown }).error

  if (typeof error !== 'string') {
    return true
  }

  return REVOKED_ANYWAY.has(error)
}
