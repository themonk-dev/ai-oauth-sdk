import { defineProvider } from './define.js'

/**
 * OpenRouter — a deliberately non-standard flow, kept working through the
 * `buildAuthParams` / `parseTokenResponse` hooks rather than a special case.
 *
 * Three ways it departs from OAuth 2.0:
 *  1. The redirect is `callback_url`, not `redirect_uri`.
 *  2. No `client_id`, `response_type`, `scope` or `state` is sent — the app is
 *     identified by its callback URL alone.
 *  3. The exchange returns `{ key }`, not `{ access_token }`, and the result is
 *     a durable user-controlled API key with no refresh token and no expiry.
 *
 * Because no `state` comes back, this provider sets `echoesState: false` and
 * resolves against the most recently started flow. That is fine for a CLI or a
 * single-flow app; do not use it in a multi-user server, where there is no CSRF
 * guard to rely on.
 */
export const openrouter = defineProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  /** Identified by callback URL alone — no client id exists to supply. */
  requiresClientId: false,
  authorizationUrl: 'https://openrouter.ai/auth',
  tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  scopes: [],
  redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/callback' },
  echoesState: false,
  /**
   * The key endpoint wants the PKCE *method* echoed back on the exchange, not
   * just the verifier — omit it and it answers `400 Invalid code_challenge_method`.
   * A standard token endpoint infers the method from the stored challenge; this
   * one does not. Always S256, matching `buildAuthParams`.
   */
  tokenRequest: {
    style: 'json',
    includeClientIdInBody: false,
    extraParams: { code_challenge_method: 'S256' },
  },
  buildAuthParams(params) {
    const next: Record<string, string> = { callback_url: params['redirect_uri'] ?? '' }

    if (params['code_challenge']) {
      next['code_challenge'] = params['code_challenge']
      next['code_challenge_method'] = params['code_challenge_method'] ?? 'S256'
    }

    return next
  },
  /** The key is user-controlled: no expiry, no refresh, usable forever. */
  parseTokenResponse(raw) {
    const key = raw['key']

    if (typeof key !== 'string') {
      return raw
    }

    return { ...raw, access_token: key, token_type: 'Bearer' }
  },
})
