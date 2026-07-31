import { defineProvider } from './define.js'
import type { FetchLike, TokenSet } from '../types.js'
import { OAuthError } from '../errors.js'

/**
 * GitHub Copilot — **device flow only**.
 *
 * GitHub's OAuth app for Copilot has no registered redirect URI, so the
 * authorization-code flow is unavailable. Use `client.deviceLogin()`:
 *
 * ```ts
 * const tokens = await client.deviceLogin({
 *   onCode: ({ verificationUri, userCode }) =>
 *     console.log(`Open ${verificationUri} and enter ${userCode}`),
 * })
 * ```
 *
 * The `ghu_` token this yields is a *GitHub* token, not a Copilot API token.
 * Exchange it with {@link exchangeForCopilotToken} to call the Copilot API;
 * that second token is short-lived (~30 min) and is meant to be re-fetched
 * rather than stored.
 */
export const githubCopilot = defineProvider({
  id: 'github-copilot',
  label: 'GitHub Copilot',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  deviceAuthorizationUrl: 'https://github.com/login/device/code',
  apiBaseUrl: 'https://api.githubcopilot.com',
  scopes: ['read:user', 'copilot'],
  /** GitHub's device flow does not use PKCE. */
  usePkce: false,
  redirect: { mode: 'custom' },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  note:
    'Supply a clientId — publicClientIds["github-copilot"] is the one VS Code ' +
    'and the Copilot CLI use. GitHub Copilot supports the device flow only, so ' +
    'use client.deviceLogin(). ' +
    'Exchange the resulting token with exchangeForCopilotToken() before calling ' +
    'the Copilot API.',
})

export interface CopilotApiToken {
  token: string
  expiresAt: number
  /** Endpoints and feature flags GitHub returns alongside the token. */
  raw: Record<string, unknown>
}

/**
 * Trades a GitHub `ghu_` token for a short-lived Copilot API token.
 *
 * Copilot's API does not accept the GitHub token directly. The returned token
 * expires in roughly 30 minutes, so fetch it per session rather than storing
 * it — the durable credential is the GitHub token in your {@link TokenSet}.
 */
export async function exchangeForCopilotToken(
  tokens: TokenSet,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<CopilotApiToken> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${tokens.accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'ai-oauth-sdk',
    },
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) {
    throw new OAuthError(
      'token_request_failed',
      `Copilot token exchange failed (HTTP ${response.status}). ` +
        'Check that the account has an active Copilot subscription.',
      { status: response.status },
    )
  }

  const raw = (await response.json()) as Record<string, unknown>
  const token = raw['token']

  if (typeof token !== 'string') {
    throw new OAuthError('invalid_token_response', 'Copilot token exchange returned no token.')
  }

  return {
    token,
    expiresAt:
      typeof raw['expires_at'] === 'number' ? raw['expires_at'] * 1000 : Date.now() + 25 * 60_000,
    raw,
  }
}
