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
 *
 * Three curl examples repeat this number, because a shell command cannot read a
 * constant: `docs/content/quick-start.mdx`, `docs/content/runtimes/cli.mdx` and
 * `packages/cli/README.md`. Update them alongside it.
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
  /**
   * Only `/responses` gets rewritten, and the route is read by trimming the
   * query and fragment off the string rather than by parsing it.
   *
   * `new URL(url, …).pathname` was the obvious way to write this and cannot be
   * used: React Native's URL shim throws from `pathname`, and this runs on
   * *every* string-bodied request to the descriptor — so the throw landed on
   * requests that were never going to be transformed at all, including the
   * `/models` call, and it landed before the check that would have returned the
   * body untouched. `url` arrives here already resolved against the base URL
   * and already carrying `client_version`, so what is left after the `?` and
   * `#` is exactly the path `pathname` would have reported.
   */
  transformRequestBody(url, body) {
    const path = (url.split('#')[0] ?? '').split('?')[0] ?? ''

    if (!path.endsWith('/responses')) {
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

/**
 * Reads the ChatGPT plan (`free`, `plus`, `pro`, `business`, `enterprise`,
 * `edu`) off the token claims, `id_token` first and `access_token` as the
 * fallback, since OpenAI writes the same namespaced claim into both.
 *
 * A plan gate is the first thing a subscription-backed feature checks — voice
 * is the current example — so it is read once here rather than by every caller
 * that knows the claim's URL-shaped key.
 */
export function chatgptPlanType(tokens: Pick<TokenSet, 'accessToken' | 'idToken'>): string | undefined {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) {
      continue
    }

    const plan = readAuthClaim(decodeJwtPayload(token))['chatgpt_plan_type']

    if (typeof plan === 'string' && plan) {
      return plan
    }
  }

  return undefined
}

/**
 * The `auth.json` the Codex CLI reads from `$CODEX_HOME`. Verified against
 * `codex-rs/login/src/token_data.rs` and `auth/storage.rs` at 0.154.0.
 */
export interface CodexAuthJson {
  auth_mode: 'chatgpt'
  OPENAI_API_KEY: null
  /** ISO 8601. Codex refreshes on its own once this is old enough. */
  last_refresh: string
  tokens: {
    access_token: string
    account_id?: string
    id_token: string
    refresh_token: string
  }
}

/**
 * Renders a token set as the file the Codex CLI reads, so a signed-in user's
 * subscription can drive `codex` itself — `codex app-server`, `codex exec` —
 * from a private `CODEX_HOME` rather than from the user's global login.
 *
 * Two of the fields are stricter than `TokenSet` is, and getting either wrong
 * is silent: Codex fails to parse the whole file, runs with no credentials, and
 * sends the request to `api.openai.com` where it fails with "You didn't provide
 * an API key". Neither can be `null`:
 *
 * - `id_token` must be a JWT carrying the `https://api.openai.com/auth` claims,
 *   because Codex parses it on load. The access token carries the same claims,
 *   so it stands in when the flow returned no id_token.
 * - `refresh_token` must be a string. A flow that keeps the refresh token
 *   elsewhere (a browser tab, say) writes an empty one, and the call simply
 *   cannot outlive the access token.
 *
 * The result is a credential file: write it `0600`, into a directory nothing
 * else reads, and delete it with the process that used it.
 */
export function codexAuthJson(
  tokens: Pick<TokenSet, 'accessToken' | 'accountId' | 'idToken' | 'refreshToken'>,
  options: { now?: Date } = {},
): CodexAuthJson {
  const idToken = tokens.idToken ?? tokens.accessToken

  if (!tokens.accessToken || !decodeJwtPayload(idToken)) {
    throw new OAuthError(
      'invalid_token_response',
      'Codex needs a JWT id_token (or access token) carrying the ChatGPT claims; this token set has neither.',
    )
  }

  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: (options.now ?? new Date()).toISOString(),
    tokens: {
      access_token: tokens.accessToken,
      ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
      id_token: idToken,
      refresh_token: tokens.refreshToken ?? '',
    },
  }
}
