import { OAuthError } from '../errors.js'
import type { FetchLike, ProviderConfig, ProviderInput } from '../types.js'
import { defineProvider } from './define.js'
import { claude } from './claude.js'
import { githubCopilot } from './github-copilot.js'
import { gemini } from './gemini.js'
import { openai } from './openai.js'
import { openrouter } from './openrouter.js'
import { qwen } from './qwen.js'
import { xai } from './xai.js'

export { defineProvider, parseStandardCallback, readCallback } from './define.js'
export { claude, gemini, githubCopilot, openai, openrouter, qwen, xai }
export { copilotClientHeaders, exchangeForCopilotToken } from './github-copilot.js'
export type { CopilotApiToken } from './github-copilot.js'
export {
  codexBaseUrl,
  codexClientVersion,
  extractCodexModelSlugs,
  fetchCodexModels,
  normalizeCodexResponsesBody,
} from './openai.js'
export { azureAi } from './azure-ai.js'
export { publicClientIds, publicClientSecrets } from './public-client-ids.js'
export type { PublicClientIdProvider } from './public-client-ids.js'
export type { AzureAiProviderOptions } from './azure-ai.js'

/** Built-in descriptors, keyed by id. */
export const providers = {
  openai,
  claude,
  gemini,
  xai,
  'github-copilot': githubCopilot,
  openrouter,
  qwen,
} as const

export type BuiltInProviderId = keyof typeof providers

/**
 * The same ids, under names you can autocomplete. Every value is the plain
 * kebab-case string, so `ProviderId.GitHubCopilot` and `'github-copilot'` are
 * interchangeable and a custom id is still just a string.
 *
 * ```ts
 * createAuthClient({
 *   provider: ProviderId.Claude,
 *   clientId: publicClientIds[ProviderId.Claude],
 * })
 * ```
 *
 * Azure AI is absent because it has no fixed id to name: its endpoints are
 * tenant-scoped, so you build the descriptor with `azureAi({ tenant })`.
 */
export const ProviderId = {
  OpenAI: 'openai',
  Claude: 'claude',
  Gemini: 'gemini',
  Grok: 'xai',
  GitHubCopilot: 'github-copilot',
  OpenRouter: 'openrouter',
  Qwen: 'qwen',
} as const satisfies Record<string, BuiltInProviderId>

/** Anything accepted where a provider is expected. */
export type ProviderLike = BuiltInProviderId | (string & {}) | ProviderConfig

export function isProviderConfig(value: unknown): value is ProviderConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProviderConfig).id === 'string' &&
    typeof (value as ProviderConfig).authorizationUrl === 'string'
  )
}

/**
 * Resolves a provider id or inline config into a full descriptor, applying any
 * per-call overrides (`clientId`, `scopes`, custom endpoints).
 */
export function resolveProvider(
  provider: ProviderLike,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  let base: ProviderConfig

  if (isProviderConfig(provider)) {
    base = provider
  } else {
    const found = (providers as Record<string, ProviderConfig | undefined>)[provider]

    if (!found) {
      throw new OAuthError(
        'unknown_provider',
        `Unknown provider "${provider}". Built-ins: ${Object.keys(providers).join(', ')}. ` +
          'Pass a descriptor from `defineProvider()` to use a custom one.',
      )
    }

    base = found
  }

  const merged: ProviderConfig = {
    ...base,
    ...overrides,
    redirect: { ...base.redirect, ...overrides.redirect },
    extraAuthParams: { ...base.extraAuthParams, ...overrides.extraAuthParams },
    tokenRequest: { ...base.tokenRequest, ...overrides.tokenRequest },
    // `defineProvider` already defaults these, but it is not the only way a
    // descriptor gets here: a cast, or a plain-JavaScript caller, reaches this
    // function having never been through it. Every client construction does pass
    // through here, so PKCE is defaulted on at the one point that sees them all.
    // Still `??`, so an explicit `false` on either side is honoured.
    usePkce: overrides.usePkce ?? base.usePkce ?? true,
    pkceMethod: overrides.pkceMethod ?? base.pkceMethod ?? 'S256',
  }

  if (overrides.scopes?.length) {
    merged.scopes = overrides.scopes
  }

  return merged
}

interface DiscoveryDocument {
  authorization_endpoint?: string
  token_endpoint?: string
  device_authorization_endpoint?: string
  scopes_supported?: string[]
}

/**
 * Hosts that RFC 8252 treats as loopback. Traffic to them never leaves the
 * machine, so cleartext there is not a wire risk — and a local development
 * authorization server on `http://127.0.0.1:<port>` is the normal case.
 */
const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * The one rule, shared by every URL in a discovery exchange. It returns a
 * verdict rather than throwing so each caller can name its own value: what is
 * wrong with an `http` `token_endpoint` and what is wrong with an `http` issuer
 * are different sentences, and the reader only ever sees one of them.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value)

    return parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname)
  } catch {
    return false
  }
}

function classifyDiscoveryUrl(value: string): 'ok' | 'unparseable' | 'insecure' {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    return 'unparseable'
  }

  if (parsed.protocol === 'https:') {
    return 'ok'
  }

  if (parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname)) {
    return 'ok'
  }

  return 'insecure'
}

/**
 * Endpoints lifted out of a discovery document come from a *remote* party, so
 * they get a check that `defineProvider` deliberately does not apply to
 * hand-written config: there, an `http` URL is something the integrator typed
 * themselves and chose to live with.
 *
 * Here the same value is attacker-reachable. An `https` issuer — TLS-verified,
 * and the only thing the integrator actually vouched for — whose document names
 * an `http` `token_endpoint` would have us POST refresh tokens and the client
 * secret in cleartext for the entire life of the descriptor, silently. And the
 * `authorization_endpoint` is the only remotely-supplied string that reaches the
 * platform browser launcher, where a `%VAR%` in it is expanded by cmd.exe on
 * Windows.
 *
 * The message names the field and the offending value, because the failure
 * surfaces at client construction time far from whoever runs the discovery
 * endpoint.
 */
function assertSecureDiscoveredEndpoint(field: string, value: string, source: string): void {
  const verdict = classifyDiscoveryUrl(value)

  if (verdict === 'unparseable') {
    throw new OAuthError(
      'configuration_error',
      `Discovery document at ${source} has a ${field} that is not a valid URL: "${value}".`,
    )
  }

  if (verdict === 'insecure') {
    throw new OAuthError(
      'configuration_error',
      `Discovery document at ${source} names an insecure ${field}: "${value}". ` +
        'Endpoints taken from a discovery document must use https, except on loopback.',
    )
  }
}

/**
 * The issuer gets the same rule as the values its document carries, and it has
 * to, because it is the transport that delivers them. Checking only the
 * document's endpoints leaves the strictly worse case open: a cleartext issuer
 * lets whoever is on the network path write the document, and endpoints they
 * choose pass the `https` check above — which then reads as a stamp of
 * validation on values that were never the issuer's. The descriptor carries
 * them for its whole life, so every later code exchange and refresh POSTs the
 * authorization code, the PKCE verifier and the client secret to that party.
 *
 * This is what the reasoning above already assumed ("an `https` issuer —
 * TLS-verified, and the only thing the integrator actually vouched for"); it
 * was simply never enforced.
 *
 * Same loopback exemption, so a local authorization server on
 * `http://127.0.0.1:<port>` keeps working. An integrator with a genuinely
 * plaintext internal IDP still has the documented escape hatch: pass
 * `authorizationUrl`/`tokenUrl` explicitly and they are left alone — but then
 * the endpoints are theirs, not a remote party's.
 */
function assertSecureIssuer(issuer: string): void {
  const verdict = classifyDiscoveryUrl(issuer)

  if (verdict === 'unparseable') {
    throw new OAuthError(
      'configuration_error',
      `Discovery issuer is not a valid URL: "${issuer}". ` +
        'Pass the issuer origin, not the .well-known path.',
    )
  }

  if (verdict === 'insecure') {
    throw new OAuthError(
      'configuration_error',
      `Insecure discovery issuer: "${issuer}". The document fetched from it decides this ` +
        'provider\'s authorization and token endpoints, so anyone on the network path can ' +
        'choose them — including https ones, which would pass every later check. The issuer ' +
        'must use https, except on loopback.',
    )
  }
}

/**
 * The issuer check above constrains where the request was *sent*; this one
 * constrains where the document was actually *served from*.
 *
 * `fetch` follows redirects by default, and outside a browser nothing bars an
 * https→http hop — Node's does follow one. So an https issuer that redirects
 * down to cleartext lands us right back in the case {@link assertSecureIssuer}
 * exists to prevent: whoever is on the network path writes the document, names
 * `https` endpoints of their own, and those pass every later check and are
 * carried by the descriptor for its whole life. The realistic way to get there
 * is not an attacker — they cannot answer the https request in the first place
 * — but an issuer behind a TLS-terminating proxy that ignores
 * `X-Forwarded-Proto` and emits an absolute `Location: http://…` when it
 * canonicalises a host or a trailing slash.
 *
 * Deliberately a scheme check and nothing more. Refusing redirects outright, or
 * requiring the final origin to match the issuer, would break issuers that
 * legitimately redirect for path normalisation or to a separate identity host,
 * and those hops are not the problem. The `http`→`https` upgrade that once
 * argued against checking here can no longer occur: an `http` issuer is now
 * refused before any request is made.
 *
 * The loopback exemption is inherited only when the issuer was itself loopback.
 * A local development server redirecting within `127.0.0.1` is ordinary; a
 * public `https` issuer redirecting *down* onto loopback is not, and would hand
 * the choice of endpoints to whatever local process holds that port.
 *
 * A `FetchLike` that returns a hand-built `Response` leaves `url` empty, so
 * stubs and test doubles are untouched.
 */
function assertSecureDiscoveryResponse(
  url: string,
  issuer: string,
  response: { url?: string },
): void {
  const finalUrl = response.url

  if (!finalUrl) {
    return
  }

  /* https is always fine. Cleartext on loopback is fine only when the issuer was
     already there — a local development server redirecting within `127.0.0.1`.
     Everything else, `unparseable` included, is refused: the sibling checks
     refuse an unparseable URL too, and a value we cannot read is not one we can
     vouch for. */
  const acceptable =
    isHttpsUrl(finalUrl) || (isLoopbackUrl(finalUrl) && isLoopbackUrl(issuer))

  if (acceptable) {
    return
  }

  throw new OAuthError(
    'configuration_error',
    `Discovery for ${url} was redirected to an unusable URL: "${finalUrl}". The document ` +
      'decides this provider\'s authorization and token endpoints, so it must arrive over ' +
      'https — or over loopback, if that is where the issuer already was.',
  )
}

/**
 * Builds a descriptor from an OIDC discovery document, so providers that move
 * their endpoints (or ones this library has never heard of) work without a
 * release. Pass the issuer URL, not the `.well-known` path. It must use `https`
 * — outside loopback — for the same reason its document's endpoints must.
 *
 * `authorizationUrl`, `tokenUrl` and `scopes` are optional in `input` because
 * the discovery document supplies them. They are re-declared rather than
 * intersected with `Partial<Pick<…>>`, which would not work — a required
 * property intersected with an optional one stays required.
 */
export async function providerFromDiscovery(
  issuer: string,
  input: Omit<ProviderInput, 'authorizationUrl' | 'tokenUrl' | 'scopes'> & {
    authorizationUrl?: string
    tokenUrl?: string
    scopes?: string[]
  },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ProviderConfig> {
  // Before the fetch, not after: a request to a cleartext issuer has already
  // told an observer who the client is and invited a response by the time any
  // value could be inspected.
  assertSecureIssuer(issuer)

  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const response = await fetchImpl(url)

  assertSecureDiscoveryResponse(url, issuer, response)

  if (!response.ok) {
    throw new OAuthError(
      'configuration_error',
      `Discovery failed for ${url} (HTTP ${response.status}).`,
      { status: response.status },
    )
  }

  const document = (await response.json()) as DiscoveryDocument
  const authorizationUrl = input.authorizationUrl ?? document.authorization_endpoint
  const tokenUrl = input.tokenUrl ?? document.token_endpoint

  if (!authorizationUrl || !tokenUrl) {
    throw new OAuthError(
      'configuration_error',
      `Discovery document at ${url} is missing authorization_endpoint or token_endpoint.`,
    )
  }

  // Guarded on `input.*` being absent rather than on the resolved value: an
  // explicitly passed `authorizationUrl`/`tokenUrl` is the integrator's own
  // config and is left alone, exactly as `defineProvider` would leave it. Only
  // the branch where the `??` fell through to the document is validated.
  //
  // `== null` rather than `=== undefined`, to match what `??` above actually
  // does. A JS caller — or a JSON config file with an unset optional key —
  // yields `null`, which falls through to the document just as `undefined`
  // does. Testing only for `undefined` would let that document value through
  // unchecked, which is the whole case this guard exists for.
  if (input.authorizationUrl == null) {
    assertSecureDiscoveredEndpoint('authorization_endpoint', authorizationUrl, url)
  }

  if (input.tokenUrl == null) {
    assertSecureDiscoveredEndpoint('token_endpoint', tokenUrl, url)
  }

  // The document's device endpoint always wins over `input.deviceAuthorizationUrl`
  // below, so it is always document-sourced when present.
  if (document.device_authorization_endpoint) {
    assertSecureDiscoveredEndpoint(
      'device_authorization_endpoint',
      document.device_authorization_endpoint,
      url,
    )
  }

  return defineProvider({
    ...input,
    authorizationUrl,
    tokenUrl,
    scopes: input.scopes ?? document.scopes_supported ?? ['openid'],
    ...(document.device_authorization_endpoint
      ? { deviceAuthorizationUrl: document.device_authorization_endpoint }
      : {}),
  })
}
