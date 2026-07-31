import { decodeJwtPayload, getStringClaim } from '../jwt.js'
import type { TokenSet } from '../types.js'
import { openaiDeviceFlow } from '../receivers/openai-device.js'
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
 *
 * Headless machines should use `client.deviceLogin()`. OpenAI's device flow is
 * not RFC 8628, so it arrives as a `deviceFlow` implementation rather than a
 * `deviceAuthorizationUrl` — see `receivers/openai-device.ts`.
 */
export const openai = defineProvider({
  id: 'openai',
  label: 'ChatGPT (OpenAI)',
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  deviceFlow: openaiDeviceFlow,
  devicePrerequisite:
    'Turn on "Enable device code authorization for Codex" in ChatGPT → Settings → Security first. ' +
    'Without it the verification page refuses the code, and this command waits for an approval that cannot arrive.',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  userInfoUrl: 'https://auth.openai.com/api/accounts/oauth/userinfo',
  /**
   * Note what a token from this flow is *not*: an API key. OpenAI's
   * authorization server advertises exactly four scopes — `openid`, `profile`,
   * `email`, `offline_access` — so a ChatGPT sign-in grants identity and the
   * ChatGPT-subscription surface, not the REST API. `GET /v1/models` answers
   * `403 … Missing scopes: api.model.read`, and no scope here can fix that.
   * Issue an API key for that.
   */
  apiBaseUrl: 'https://api.openai.com/v1',
  redirect: { mode: 'loopback', loopbackPort: 1455, loopbackPath: '/auth/callback' },
  extraAuthParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  /**
   * The account id lives in the `id_token`, in one of three shapes depending on
   * whether the user is on a personal plan or in an organization.
   */
  enrichTokens(raw, tokens: TokenSet) {
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
  /**
   * Requests made with a ChatGPT-subscription token must name the account they
   * are billed against.
   */
  apiHeaders(tokens): Record<string, string> {
    return tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}
  },
})
