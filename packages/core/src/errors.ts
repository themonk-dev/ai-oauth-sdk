/**
 * Every failure this library raises is an `OAuthError`, so callers can
 * `catch (e) { if (e instanceof OAuthError) ... }` and branch on `code`
 * instead of string-matching messages.
 */
export type OAuthErrorCode =
  /** The authorization server returned `error=` on the callback. */
  | 'authorization_denied'
  /** No pending authorization matches the supplied `state`. */
  | 'unknown_state'
  /** The pending authorization existed but has passed its TTL. */
  | 'state_expired'
  /** Callback `state` did not match what we issued (possible CSRF). */
  | 'state_mismatch'
  /** The token endpoint responded with a non-2xx status. */
  | 'token_request_failed'
  /** The token endpoint responded 2xx but the body was unusable. */
  | 'invalid_token_response'
  /** No refresh token is available, or the provider rejected it. */
  | 'refresh_failed'
  /** The flow was aborted via an `AbortSignal` or an explicit cancel. */
  | 'aborted'
  /** The flow exceeded the configured timeout. */
  | 'timeout'
  /** Device authorization ended without approval. */
  | 'device_flow_failed'
  /** A provider id was requested that is not in the registry. */
  | 'unknown_provider'
  /** Required configuration (usually `clientId`) was missing. */
  | 'configuration_error'
  /** The active runtime cannot support the requested operation. */
  | 'unsupported_runtime'

export interface OAuthErrorOptions {
  cause?: unknown
  /** Raw `error` field from the provider, when it supplied one. */
  providerError?: string
  /** Raw `error_description` from the provider, when it supplied one. */
  providerErrorDescription?: string
  /** HTTP status, for failures originating from a network response. */
  status?: number
  /** The `state` the failure relates to, when applicable. */
  state?: string
}

export class OAuthError extends Error {
  override readonly name = 'OAuthError'
  readonly code: OAuthErrorCode
  readonly providerError?: string
  readonly providerErrorDescription?: string
  readonly status?: number
  readonly state?: string

  constructor(code: OAuthErrorCode, message: string, options: OAuthErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.code = code
    this.providerError = options.providerError
    this.providerErrorDescription = options.providerErrorDescription
    this.status = options.status
    this.state = options.state
  }
}

/** Narrowing helper that survives multiple copies of the package on disk. */
export function isOAuthError(value: unknown): value is OAuthError {
  return value instanceof Error && value.name === 'OAuthError' && 'code' in value
}
