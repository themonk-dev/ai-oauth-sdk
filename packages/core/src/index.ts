export { AuthClient, createAuthClient } from './client.js'
export type {
  AuthClientOptions,
  CompleteAuthorizationInput,
  CreateAuthorizationOptions,
  CreatedAuthorization,
  DeviceLoginOptions,
  LoginOptions,
} from './client.js'

export {
  azureAi,
  codexBaseUrl,
  codexClientVersion,
  copilotClientHeaders,
  defineProvider,
  exchangeForCopilotToken,
  extractCodexModelSlugs,
  fetchCodexModels,
  claude,
  gemini,
  githubCopilot,
  isProviderConfig,
  normalizeCodexResponsesBody,
  openai,
  openrouter,
  parseStandardCallback,
  providerFromDiscovery,
  ProviderId,
  publicClientIds,
  publicClientSecrets,
  providers,
  qwen,
  readCallback,
  resolveProvider,
  xai,
} from './providers/index.js'
export type {
  AzureAiProviderOptions,
  BuiltInProviderId,
  CopilotApiToken,
  ProviderLike,
  PublicClientIdProvider,
} from './providers/index.js'

/* observable state, shared by every UI binding */
export { createAuthStore } from './store.js'
export type { AuthState, AuthStore, AuthStoreOptions, LoginOverrides } from './store.js'

/* using the token */
export { createAuthenticatedFetch, fetchUserInfo } from './fetch.js'
export type { AuthenticatedFetchOptions, UserInfo } from './fetch.js'
export { fetchWithSignal } from './http.js'
export { revokeToken } from './revoke.js'
export type { RevocableTokenType, RevokeTokenInput } from './revoke.js'

/* flow primitives */
export { buildAuthorizationUrl, buildLoopbackRedirectUri, defaultRedirectUri } from './authorize.js'
export type { BuildAuthorizationUrlInput } from './authorize.js'
/* A receiver that has to read a param back out of an authorization URL needs
   the same parser the URL was built with, and on Hermes cannot reach for
   `URLSearchParams` to do it — see `query.ts` for why. */
export { parseQuery } from './query.js'
export { DEFAULT_EXPIRY_SKEW_MS, exchangeCode, isExpired, refreshTokens } from './token.js'
export type { ExchangeCodeInput, RefreshTokensInput } from './token.js'
export { AuthorizationRegistry } from './registry.js'
export type { AuthorizationRegistryOptions } from './registry.js'

export { manualReceiver } from './receivers/manual.js'
export type { ManualReceiverOptions } from './receivers/manual.js'
export { pollDeviceToken, startDeviceAuthorization } from './receivers/device.js'
export { openaiDeviceFlow } from './receivers/openai-device.js'
export type {
  DeviceCodeResponse,
  PollDeviceTokenInput,
  StartDeviceAuthorizationInput,
} from './receivers/device.js'
export type { DeviceFlow, DeviceFlowPollInput, DeviceFlowStartInput } from './types.js'

export { createDefaultCrypto, hasSecureRandom } from './crypto/adapter.js'
export type { CryptoAdapter } from './crypto/adapter.js'
export { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from './crypto/encoding.js'
export { sha256 } from './crypto/sha256.js'
export { createPkce, createRandomString, createVerifier, deriveChallenge } from './pkce.js'
export type { PkceMethod, PkcePair } from './pkce.js'
export { decodeJwtPayload, getClaim, getStringClaim } from './jwt.js'

export { fromSyncStorage, memoryStorage, prefixedStorage } from './storage.js'
export type { SyncStorageLike } from './storage.js'

/* hardening helpers */
export { timingSafeEqual } from './compare.js'
export { REDACTED, redactSecrets, safeSnippet } from './redact.js'

export { isOAuthError, OAuthError } from './errors.js'
export type { OAuthErrorCode, OAuthErrorOptions } from './errors.js'

export type {
  AuthStorage,
  CallbackParseResult,
  CallbackReceiver,
  CallbackResult,
  FetchLike,
  LogoutResult,
  PendingAuthorization,
  ProviderConfig,
  ProviderInput,
  RedirectMode,
  RedirectSpec,
  ReceiverContext,
  ResolvedCredential,
  StartedReceiver,
  TokenRequestSpec,
  TokenSet,
} from './types.js'
