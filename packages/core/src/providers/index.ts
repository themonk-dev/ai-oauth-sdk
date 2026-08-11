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
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    throw new OAuthError(
      'configuration_error',
      `Discovery document at ${source} has a ${field} that is not a valid URL: "${value}".`,
    )
  }

  if (parsed.protocol === 'https:') {
    return
  }

  if (parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname)) {
    return
  }

  throw new OAuthError(
    'configuration_error',
    `Discovery document at ${source} names an insecure ${field}: "${value}". ` +
      'Endpoints taken from a discovery document must use https, except on loopback.',
  )
}

/**
 * Builds a descriptor from an OIDC discovery document, so providers that move
 * their endpoints (or ones this library has never heard of) work without a
 * release. Pass the issuer URL, not the `.well-known` path.
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
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const response = await fetchImpl(url)

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
  if (input.authorizationUrl === undefined) {
    assertSecureDiscoveredEndpoint('authorization_endpoint', authorizationUrl, url)
  }

  if (input.tokenUrl === undefined) {
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
