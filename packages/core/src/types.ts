import type { PkceMethod } from './pkce.js'

/** Minimal `fetch` shape, so callers can inject a proxy/instrumented client. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>


export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Absolute expiry as epoch milliseconds. Absent when the provider omits one. */
  expiresAt?: number
  tokenType: string
  scope?: string
  idToken?: string
  /** Provider account identifier, when it can be determined. */
  accountId?: string
  /** Account email, when the provider returns or encodes one. */
  email?: string
  /** The provider this token belongs to. */
  provider: string
  /**
   * The untouched token-endpoint response, for provider-specific fields.
   *
   * **This holds a second copy of every credential** — `access_token`,
   * `refresh_token`, `id_token` — because it is the response verbatim. Do not
   * log it, serialise it into telemetry, or return it from an API. The named
   * fields above are what you want; reach in here only for something a provider
   * returns that this interface has no name for.
   */
  raw: Record<string, unknown>
}


/**
 * Key/value persistence. Async so it fits `AsyncStorage`, `SecureStore`, the
 * filesystem, and a keychain equally well.
 */
export interface AuthStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /**
   * Lists stored keys. Optional, because some backends (SecureStore) cannot
   * enumerate. Callers must degrade gracefully when it is absent.
   */
  keys?(): Promise<string[]>
}


export type RedirectMode =
  /** A local HTTP server on 127.0.0.1 receives the callback (RFC 8252). */
  | 'loopback'
  /** The provider redirects to a fixed hosted URL; the user pastes the result. */
  | 'hosted'
  /** The consumer supplies the redirect URI (web app, deep link). */
  | 'custom'

export interface RedirectSpec {
  mode: RedirectMode
  /** Fixed loopback port. `0` means "pick any free port". */
  loopbackPort?: number
  /** Path the loopback server listens on. Defaults to `/callback`. */
  loopbackPath?: string
  /** Host for loopback URIs. Defaults to `localhost`. */
  loopbackHost?: string
  /** Fixed redirect URI for `hosted` mode. */
  hostedUri?: string
}

export interface TokenRequestSpec {
  /** Most providers want form encoding; a few want JSON. */
  style: 'form' | 'json'
  headers?: Record<string, string>
  /** Send `client_id` in the body (default true). */
  includeClientIdInBody?: boolean
  /** Extra fields merged into every token/refresh request body. */
  extraParams?: Record<string, string>
  /**
   * Send `state` on the code exchange. Default false.
   *
   * The spec puts `state` on the authorization request only. Anthropic also
   * accepts it on the exchange; OpenAI rejects the request outright, so this
   * cannot be on by default.
   */
  includeState?: boolean
}

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Pre-filled variant, when the provider supplies one. */
  verificationUriComplete?: string
  expiresAt: number
  intervalMs: number
  /**
   * Present when the device request carried a PKCE challenge, and the token
   * request must present the matching verifier. Treat it like `deviceCode`:
   * it is half of a credential, so keep it out of logs.
   */
  codeVerifier?: string
  /** Scratch space for a non-RFC-8628 flow to carry its own state. */
  extra?: Record<string, string>
}

export interface DeviceFlowStartInput {
  provider: ProviderConfig
  clientId: string
  scopes?: string[]
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

export interface DeviceFlowPollInput {
  provider: ProviderConfig
  clientId: string
  device: DeviceCodeResponse
  fetchImpl?: FetchLike
  signal?: AbortSignal
  onPoll?: (attempt: number) => void
}

/**
 * A device flow that is not RFC 8628.
 *
 * The RFC is the common case and needs no hook — `deviceAuthorizationUrl` is
 * enough. OpenAI is the exception: JSON request bodies rather than form
 * encoding, HTTP 403/404 as the "still pending" signal rather than
 * `authorization_pending`, a server-generated PKCE verifier, and a second hop
 * through the ordinary token endpoint. None of that is expressible as
 * configuration, so a provider supplies the two steps itself.
 */
export interface DeviceFlow {
  start(input: DeviceFlowStartInput): Promise<DeviceCodeResponse>
  poll(input: DeviceFlowPollInput): Promise<TokenSet>
}

export interface CallbackParseResult {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

export interface ProviderConfig {
  /** Stable identifier, e.g. `openai`. */
  id: string
  /** Human label for prompts and UI. */
  label: string
  authorizationUrl: string
  tokenUrl: string
  /**
   * The OAuth client id.
   *
   * No built-in provider sets this — the consumer names it at initialization,
   * the way Passport does. Well-known public ids are exported as
   * `publicClientIds` to opt into.
   */
  clientId?: string
  /**
   * Whether a client id is required at all. Default true.
   *
   * OpenRouter identifies applications by their callback URL and sends no
   * `client_id` anywhere in the flow, so demanding one would be theatre.
   */
  requiresClientId?: boolean
  /** Some providers issue a non-secret "client secret"; PKCE clients rarely need one. */
  clientSecret?: string
  scopes: string[]
  usePkce: boolean
  pkceMethod: PkceMethod
  redirect: RedirectSpec
  /** Extra query params appended to the authorization URL. */
  extraAuthParams?: Record<string, string>
  tokenRequest: TokenRequestSpec
  /** RFC 8628 device authorization endpoint, when supported. */
  deviceAuthorizationUrl?: string
  /** Overrides the RFC 8628 implementation for providers that deviate. */
  deviceFlow?: DeviceFlow
  /**
   * Something the user must do before a device login can succeed, shown
   * alongside the code.
   *
   * OpenAI needs the flow switched on per account, and refuses it on the
   * verification page rather than at the endpoint — so the CLI keeps polling a
   * code that can never be approved. Saying it up front is the only fix
   * available on our side.
   */
  devicePrerequisite?: string
  /** RFC 7009 revocation endpoint, when supported. */
  revocationUrl?: string
  /** OIDC userinfo endpoint, when supported. */
  userInfoUrl?: string
  /** Base URL of the provider's API, for convenience. */
  apiBaseUrl?: string
  /**
   * Parses whatever the user pastes back. Defaults to URL/query parsing;
   * providers like Anthropic hand back a bare `code#state` string.
   */
  parseCallback?: (input: string) => CallbackParseResult
  /**
   * Last chance to rewrite the authorization query before the URL is built.
   *
   * Receives the conventional params (`response_type`, `client_id`,
   * `redirect_uri`, `state`, `scope`, PKCE) and returns the final set. Needed
   * for providers that deviate from the spec — OpenRouter names its redirect
   * `callback_url` and sends no `client_id`, `state` or `scope` at all.
   */
  buildAuthParams?: (params: Record<string, string>) => Record<string, string>
  /**
   * Normalizes a non-standard token response into the conventional shape
   * (`access_token`, `refresh_token`, `expires_in`, …).
   */
  parseTokenResponse?: (raw: Record<string, unknown>) => Record<string, unknown>
  /**
   * Whether the provider returns `state` on the callback. Default true.
   *
   * When false the library falls back to the most recently started flow for
   * this provider, since there is nothing to correlate on. That is safe for a
   * CLI or a single-flow app, but it means no CSRF guard — avoid such
   * providers in a multi-user server.
   */
  echoesState?: boolean
  /** Derives `accountId`/`email` from the raw token response. */
  enrichTokens?: (raw: Record<string, unknown>, tokens: TokenSet) => Partial<TokenSet>
  /**
   * Extra headers every API request needs beyond `Authorization` — OpenAI wants
   * the account id, Anthropic wants a version and a beta flag. Used by
   * `createAuthenticatedFetch`.
   */
  apiHeaders?: (tokens: TokenSet) => Record<string, string>
  /** Marks providers whose constants are not officially published. */
  experimental?: boolean
  /** Free-form note surfaced in errors and docs. */
  note?: string
}

/** Everything except the fields that carry sensible defaults. */
export type ProviderInput = Omit<ProviderConfig, 'usePkce' | 'pkceMethod' | 'tokenRequest'> &
  Partial<Pick<ProviderConfig, 'usePkce' | 'pkceMethod' | 'tokenRequest'>>


/**
 * A started-but-unfinished login, keyed by `state`.
 *
 * Persisting this is what lets the flow survive a process boundary — a full
 * page redirect in an SPA, or a callback arriving on a different HTTP request
 * than the one that started the flow.
 */
export interface PendingAuthorization {
  state: string
  provider: string
  redirectUri: string
  codeVerifier?: string
  createdAt: number
  expiresAt: number
  /** Caller-supplied data, returned untouched when the flow completes. */
  metadata?: Record<string, unknown>
}


export interface ReceiverContext {
  provider: ProviderConfig
  /** Opens a URL however the runtime prefers (spawn browser, `location.assign`). */
  openUrl?: (url: string) => void | Promise<void>
  signal?: AbortSignal
}

export interface CallbackResult {
  code: string
  state?: string
}

/**
 * A started receiver: knows its redirect URI, can present the authorization
 * URL to the user, and resolves once the callback lands.
 */
export interface StartedReceiver {
  redirectUri: string
  /** Show the authorization URL to the user (open a browser, print, redirect). */
  present(url: string): Promise<void>
  /**
   * Resolves with the callback payload. May never resolve for receivers that
   * hand control to a page navigation — those resolve on the next load instead.
   */
  wait(): Promise<CallbackResult>
  close(): Promise<void>
}

/**
 * Strategy for getting the authorization code back from the browser.
 *
 * This is the seam that lets one core serve a CLI (loopback server), an SPA
 * (popup or full-page redirect), a mobile app (deep link) and a headless box
 * (manual paste) without any of them knowing about the others.
 */
export interface CallbackReceiver {
  readonly id: string
  start(context: ReceiverContext): Promise<StartedReceiver>
}
