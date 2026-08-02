import { OAuthError } from '../errors.js'
import type { FetchLike, ProviderConfig, ProviderInput } from '../types.js'
import { defineProvider } from './define.js'
import { anthropic } from './anthropic.js'
import { githubCopilot } from './github-copilot.js'
import { google } from './google.js'
import { openai } from './openai.js'
import { openrouter } from './openrouter.js'
import { qwen } from './qwen.js'
import { xai } from './xai.js'

export { defineProvider, parseStandardCallback, readCallback } from './define.js'
export { anthropic, githubCopilot, google, openai, openrouter, qwen, xai }
/** Product name for {@link anthropic}. The provider id stays `anthropic`. */
export { anthropic as claude } from './anthropic.js'
export { copilotClientHeaders, exchangeForCopilotToken } from './github-copilot.js'
export type { CopilotApiToken } from './github-copilot.js'
export {
  codexBaseUrl,
  codexClientVersion,
  extractCodexModelSlugs,
  fetchCodexModels,
  normalizeCodexResponsesBody,
} from './openai.js'
export { azureAi, microsoft } from './microsoft.js'
export { publicClientIds, publicClientSecrets } from './public-client-ids.js'
export type { PublicClientIdProvider } from './public-client-ids.js'
export type { AzureAiProviderOptions, MicrosoftProviderOptions } from './microsoft.js'

/** Built-in descriptors, keyed by id. */
export const providers = {
  openai,
  anthropic,
  google,
  xai,
  'github-copilot': githubCopilot,
  openrouter,
  qwen,
} as const

export type BuiltInProviderId = keyof typeof providers

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
