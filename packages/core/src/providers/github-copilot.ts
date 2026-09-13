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
 * Hosts RFC 8252 treats as loopback, matching the set `providers/index.ts`
 * exempts for the same reason: traffic to them never leaves the machine, so
 * cleartext there is not a wire risk, and a proxy or a recording fixture on
 * `http://127.0.0.1:<port>` is a normal way to drive this.
 */
const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * Reads the API host out of the exchange response.
 *
 * GitHub returns it under `endpoints.api`. Undefined when it is absent, which
 * leaves the descriptor's `apiBaseUrl` in place rather than guessing — the
 * behaviour the `apiBaseUrl` comment above already describes as intended.
 *
 * A value that does not parse, or that names anything but `https` off loopback,
 * is treated the same way as absent. This is the rule
 * `assertSecureDiscoveredEndpoint` applies in `providers/index.ts`, and it is
 * applied here for consistency with it rather than because there is a live hole:
 * this document arrives over TLS from a hard-coded `https://api.github.com`, so
 * writing an `http://` host into it means having already broken that connection.
 * It is defence in depth and nothing more.
 *
 * What makes it worth having anyway is where the value ends up. It becomes
 * `ResolvedCredential.baseUrl`, and every later relative-path request through
 * `createAuthenticatedFetch` is resolved against it carrying the Copilot bearer
 * token — so a single unexamined string decides, for the life of that credential,
 * who receives it. That is exactly the shape of the discovery case: a remotely
 * supplied endpoint that silently redirects a credential, with nothing anomalous
 * for the caller to notice.
 *
 * It returns `undefined` rather than throwing, which is the one place it
 * deliberately diverges from the discovery check. That one runs at construction
 * time, where refusing costs nobody a session; this one runs in the middle of a
 * live exchange, and falling back to the descriptor's own `apiBaseUrl` keeps a
 * sign-in working instead of breaking it over a defence-in-depth check.
 *
 * The host is deliberately *not* pinned to `api.githubcopilot.com` or to a
 * `github.com` suffix. Enterprise accounts genuinely get a different host — that
 * is the whole reason this field is read rather than configured — so anything
 * narrower than "must be https" would refuse legitimate deployments.
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

  let parsed: URL

  try {
    parsed = new URL(api)
  } catch {
    /* Unparseable is refused rather than waved through, as the discovery
       check does with one: a value nothing can make sense of is not a host
       this credential should be sent to. */
    return undefined
  }

  if (parsed.protocol === 'https:') {
    return api
  }

  if (parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname)) {
    return api
  }

  return undefined
}
