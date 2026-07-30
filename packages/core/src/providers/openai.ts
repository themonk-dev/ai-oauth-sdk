import { decodeJwtPayload, getStringClaim } from '../jwt.js'
import type { TokenSet } from '../types.js'
import { defineProvider } from './define.js'

/**
 * OpenAI namespaces its custom claims under a URL. That key contains dots, so
 * it must be read directly rather than through a dotted-path helper.
 */
const AUTH_CLAIM = 'https://api.openai.com/auth'

function readAuthClaim(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const claim = payload?.[AUTH_CLAIM]
  return typeof claim === 'object' && claim !== null ? (claim as Record<string, unknown>) : {}
}

/**
 * OpenAI / ChatGPT — the flow the Codex CLI uses.
 *
 * Supply a `clientId`: your own, or `publicClientIds.openai` to present as the
 * Codex CLI. PKCE means no secret is involved either way. The three extra
 * authorize params are OpenAI-specific — they ask for organization claims in the
 * id_token and select the simplified CLI consent screen.
 */
export const openai = defineProvider({
  id: 'openai',
  label: 'ChatGPT (OpenAI)',
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  apiBaseUrl: 'https://api.openai.com/v1',
  redirect: { mode: 'loopback', loopbackPort: 1455, loopbackPath: '/auth/callback' },
  extraAuthParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  enrichTokens(raw, tokens: TokenSet) {
    // The account id lives in the id_token, in one of three shapes depending on
    // whether the user is on a personal plan or in an organization.
    const payload = decodeJwtPayload(tokens.idToken ?? String(raw['id_token'] ?? ''))
    const authClaim = readAuthClaim(payload)

    const organizations = authClaim['organizations']
    const firstOrgId =
      Array.isArray(organizations) && typeof organizations[0] === 'object' && organizations[0] !== null
        ? (organizations[0] as Record<string, unknown>)['id']
        : undefined

    const namespacedAccountId = authClaim['chatgpt_account_id']
    const accountId =
      getStringClaim(payload, 'chatgpt_account_id') ??
      (typeof namespacedAccountId === 'string' ? namespacedAccountId : undefined) ??
      (typeof firstOrgId === 'string' ? firstOrgId : undefined)

    const email = getStringClaim(payload, 'email')
    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) }
  },
  apiHeaders(tokens): Record<string, string> {
    // Requests made with a ChatGPT-subscription token must name the account
    // they are billed against.
    return tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}
  },
})
