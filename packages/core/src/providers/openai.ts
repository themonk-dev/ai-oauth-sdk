import { OAuthError } from '../errors.js'
import { createAuthenticatedFetch } from '../fetch.js'
import { decodeJwtPayload, getStringClaim } from '../jwt.js'
import type { AuthClient } from '../client.js'
import type { FetchLike, TokenSet } from '../types.js'
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
 * The surface a ChatGPT subscription token actually works against.
 *
 * Not `api.openai.com`: that is the REST API, it wants an API key, and it
 * answers a token from this flow with `403 Missing scopes: api.model.read`.
 * This is where the Codex CLI sends its requests.
 */
export const codexBaseUrl = 'https://chatgpt.com/backend-api/codex'

/**
 * Sent as `client_version` on every Codex request. The backend gates the model
 * list on it, so an absent or stale value makes every model report as
 * unsupported. Bump it toward the current Codex CLI release if models vanish.
 */
export const codexClientVersion = '0.142.5'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Adapts a standard OpenAI responses payload for the Codex endpoint.
 *
 * The backend runs stateless, and a request that ignores what that implies gets
 * back a 200 with an empty stream rather than an error, which is a miserable
 * thing to debug. Four requirements, none of them documented:
 *
 * - `store` must be false.
 * - `reasoning` must be configured, because Codex models always reason.
 * - `include` must ask for `reasoning.encrypted_content`, which is how
 *   reasoning survives between turns when the server keeps nothing.
 * - input items must carry no server-side ids, and `item_reference` items
 *   (which an SDK emits when it assumes server-side storage) must be dropped.
 * - `max_output_tokens` and `max_completion_tokens` are rejected outright.
 *
 * Anything the caller sets explicitly is kept, so this fills gaps rather than
 * overriding intent.
 */
export function normalizeCodexResponsesBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, store: false }

  out['reasoning'] = {
    effort: 'medium',
    summary: 'auto',
    ...(isRecord(out['reasoning']) ? out['reasoning'] : {}),
  }

  const include = new Set(
    Array.isArray(out['include'])
      ? out['include'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  )
  include.add('reasoning.encrypted_content')
  out['include'] = [...include]

  if (Array.isArray(out['input'])) {
    out['input'] = out['input']
      .filter((item) => !(isRecord(item) && item['type'] === 'item_reference'))
      .map((item) => {
        if (!isRecord(item) || !('id' in item)) {
          return item
        }

        const { id: _id, ...rest } = item

        return rest
      })
  }

  delete out['max_output_tokens']
  delete out['max_completion_tokens']

  return out
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
   * ChatGPT-subscription surface, not the REST API. Pointed here at that
   * subscription surface, which is the one these tokens open. Override it with
   * the `baseUrl` option on `createAuthenticatedFetch` for an API-key account.
   */
  apiBaseUrl: codexBaseUrl,
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
   * are billed against. The other two identify the caller to the Codex backend,
   * which refuses the request without them.
   */
  apiHeaders(tokens): Record<string, string> {
    return {
      ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    }
  },
  apiQuery(): Record<string, string> {
    return { client_version: codexClientVersion }
  },
  transformRequestBody(url, body) {
    if (!new URL(url, 'http://relative.invalid').pathname.endsWith('/responses')) {
      return body
    }

    return normalizeCodexResponsesBody(body)
  },
})

/**
 * Lists the model slugs the signed-in ChatGPT account can actually use.
 *
 * Worth calling rather than hardcoding a slug: the set depends on the user's
 * plan, and the backend filters it by the `client_version` the descriptor
 * sends, so two accounts on the same library version can see different models.
 */
export async function fetchCodexModels(
  client: AuthClient,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<string[]> {
  const authenticatedFetch = createAuthenticatedFetch(client, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const response = await authenticatedFetch('/models', {
    headers: { Accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) {
    throw new OAuthError(
      'token_request_failed',
      `Codex model list request failed (HTTP ${response.status}).`,
      { status: response.status },
    )
  }

  return extractCodexModelSlugs(await response.json())
}

/**
 * Pulls model slugs out of the shapes the Codex model list has come back as.
 *
 * The endpoint is undocumented and has moved its payload around, so unknown
 * entries are skipped rather than throwing. Callers get a clean string array.
 */
export function extractCodexModelSlugs(value: unknown): string[] {
  const lists: unknown[][] = []

  if (Array.isArray(value)) {
    lists.push(value)
  } else if (isRecord(value)) {
    lists.push(...[value['models'], value['data'], value['items']].filter(Array.isArray))
  }

  const slugs = new Set<string>()

  for (const list of lists) {
    for (const item of list) {
      const candidate = readSlug(item)

      if (candidate) {
        slugs.add(candidate)
      }
    }
  }

  return [...slugs]
}

function readSlug(item: unknown): string | undefined {
  if (typeof item === 'string') {
    return item.trim() || undefined
  }

  if (!isRecord(item)) {
    return undefined
  }

  const candidate = item['slug'] ?? item['id']

  return typeof candidate === 'string' ? candidate.trim() || undefined : undefined
}
