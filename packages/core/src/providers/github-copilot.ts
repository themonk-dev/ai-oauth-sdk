import { defineProvider } from './define.js'
import type { FetchLike, ResolvedCredential, TokenSet } from '../types.js'
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
/**
 * Copilot's API refuses a request that does not say which editor it came from.
 * These are the values an editor client sends; override them through the
 * `headers` option on `createAuthenticatedFetch` to identify as yourself.
 */
export const copilotClientHeaders: Record<string, string> = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.95.0',
}

export const githubCopilot = defineProvider({
  id: 'github-copilot',
  label: 'GitHub Copilot',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  deviceAuthorizationUrl: 'https://github.com/login/device/code',
  /**
   * A default rather than the answer. The real host arrives with the exchanged
   * token, and an enterprise account gets a different one, so this is only what
   * is used if the exchange somehow names none.
   */
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
    'createAuthenticatedFetch() handles the Copilot token exchange for you; ' +
    'call exchangeForCopilotToken() directly only if you are not using it.',
  async exchangeCredential(tokens, context): Promise<ResolvedCredential> {
    const copilot = await exchangeForCopilotToken(tokens, { fetch: context.fetch })

    return {
      accessToken: copilot.token,
      expiresAt: copilot.expiresAt,
      headers: copilotClientHeaders,
      ...(copilot.apiBaseUrl ? { baseUrl: copilot.apiBaseUrl } : {}),
    }
  },
})

export interface CopilotApiToken {
  token: string
  expiresAt: number
  /**
   * The host to send this token to, when GitHub names one.
   *
   * It differs between individual and enterprise accounts, which is why it is
   * data rather than configuration. `createAuthenticatedFetch` uses it in place
   * of the descriptor's `apiBaseUrl`.
   */
  apiBaseUrl?: string
  /** Endpoints and feature flags GitHub returns alongside the token. */
  raw: Record<string, unknown>
}

/**
 * Trades a GitHub `ghu_` token for a short-lived Copilot API token.
 *
 * Copilot's API does not accept the GitHub token directly. The returned token
 * expires in roughly 30 minutes, so fetch it per session rather than storing
 * it — the durable credential is the GitHub token in your {@link TokenSet}.
 *
 * `createAuthenticatedFetch` calls this for you and caches the result, so reach
 * for it directly only when you are driving requests yourself.
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

  const apiBaseUrl = readApiEndpoint(raw)

  return {
    token,
    expiresAt:
      typeof raw['expires_at'] === 'number' ? raw['expires_at'] * 1000 : Date.now() + 25 * 60_000,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    raw,
  }
}

/**
 * Reads the API host out of the exchange response.
 *
 * GitHub returns it under `endpoints.api`, and individual, business and
 * enterprise accounts each get a different one, so it genuinely has to be read
 * rather than hard-coded. Undefined when it is absent or unusable, which leaves
 * the descriptor's `apiBaseUrl` in place rather than guessing.
 *
 * It must parse and use `https`. This value is remote-supplied — it arrives in
 * a response body, not from anything the integrator wrote — and it becomes
 * `ResolvedCredential.baseUrl`, which is the base every later request is built
 * on and every one of those requests carries `Authorization: Bearer <copilot
 * token>`. An `http://` value is therefore a cleartext downgrade of a live
 * credential, repeated for the token's whole lifetime.
 *
 * That is the same floor `providerFromDiscovery` already puts under endpoints
 * taken out of a discovery document, and for the same reason: what the
 * integrator vouched for is GitHub's certificate, not wherever GitHub's
 * response happens to point. Loopback is not exempt here as it is there,
 * because no part of Copilot's exchange is a local development server.
 *
 * Falling back rather than throwing is deliberate. A descriptor-supplied
 * `apiBaseUrl` is a working default, and failing the whole sign-in over a field
 * we have a sound answer for would be a worse trade than quietly ignoring it.
 */
function readApiEndpoint(raw: Record<string, unknown>): string | undefined {
  const endpoints = raw['endpoints']

  if (typeof endpoints !== 'object' || endpoints === null) {
    return undefined
  }

  const api = (endpoints as Record<string, unknown>)['api']

  if (typeof api !== 'string' || !api) {
    return undefined
  }

  try {
    const parsed = new URL(api)

    // The parser's `href`, so what was checked is what gets stored.
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}
