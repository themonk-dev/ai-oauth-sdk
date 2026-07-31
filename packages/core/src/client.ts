import { buildAuthorizationUrl, defaultRedirectUri } from './authorize.js'
import { timingSafeEqual } from './compare.js'
import { createDefaultCrypto, type CryptoAdapter } from './crypto/adapter.js'
import { OAuthError } from './errors.js'
import { createPkce, createRandomString } from './pkce.js'
import {
  type ProviderLike,
  parseStandardCallback,
  publicClientIds,
  resolveProvider,
} from './providers/index.js'
import { startDeviceAuthorization, pollDeviceToken, type DeviceCodeResponse } from './receivers/device.js'
import { AuthorizationRegistry } from './registry.js'
import { revokeToken, type RevocableTokenType } from './revoke.js'
import { memoryStorage } from './storage.js'
import { DEFAULT_EXPIRY_SKEW_MS, exchangeCode, isExpired, refreshTokens } from './token.js'
import type {
  AuthStorage,
  CallbackReceiver,
  CallbackResult,
  FetchLike,
  PendingAuthorization,
  ProviderConfig,
  TokenSet,
} from './types.js'

export interface AuthClientOptions {
  provider: ProviderLike
  /** Required for providers that ship without a public client id (xAI). */
  clientId?: string
  clientSecret?: string
  /** Replaces the provider's default scopes. */
  scopes?: string[]
  /** Fixed redirect URI. Receivers that own their URI take precedence. */
  redirectUri?: string
  /** Defaults to in-memory. Swap for file/localStorage/SecureStore to persist. */
  storage?: AuthStorage
  crypto?: CryptoAdapter
  fetch?: FetchLike
  /** Distinguishes token records when one app holds several accounts. */
  accountKey?: string
  /** How long a started authorization stays valid. Default 10 minutes. */
  stateTtlMs?: number
  /** Renew this far ahead of expiry. Default 60s. */
  expirySkewMs?: number
  /** Extra authorize-URL params for every flow from this client. */
  extraAuthParams?: Record<string, string>
}

export interface CreateAuthorizationOptions {
  redirectUri?: string
  scopes?: string[]
  extraParams?: Record<string, string>
  /** Round-tripped untouched; read it back off the completed flow. */
  metadata?: Record<string, unknown>
}

export interface CreatedAuthorization {
  /** Send the user here. */
  url: string
  /** Correlation id. Everything else keys off this. */
  state: string
  redirectUri: string
  codeVerifier?: string
}

export interface CompleteAuthorizationInput {
  code?: string
  state?: string
  /** Full redirect URL (or pasted `code#state`) instead of `code`/`state`. */
  callbackUrl?: string
  signal?: AbortSignal
}

export interface LoginOptions {
  receiver: CallbackReceiver
  signal?: AbortSignal
  timeoutMs?: number
  scopes?: string[]
  extraParams?: Record<string, string>
  metadata?: Record<string, unknown>
  /** Opens the authorization URL; receivers usually supply their own. */
  openUrl?: (url: string) => void | Promise<void>
}

export interface DeviceLoginOptions {
  signal?: AbortSignal
  scopes?: string[]
  /** Show the user code and verification URL. */
  onCode: (device: DeviceCodeResponse) => void | Promise<void>
}

const TOKENS_PREFIX = 'tokens:'

/**
 * The orchestrator.
 *
 * Three ways to use it, in increasing order of "I want it done for me":
 *  1. {@link AuthClient.createAuthorization} + {@link AuthClient.completeAuthorization}
 *     — you own the browser and the callback plumbing entirely.
 *  2. {@link AuthClient.waitForAuthorization} — start anywhere, await the result
 *     anywhere else, correlated by `state`.
 *  3. {@link AuthClient.login} — hand it a receiver and it runs the whole flow.
 */
export class AuthClient {
  readonly provider: ProviderConfig
  readonly #clientId: string
  readonly #storage: AuthStorage
  readonly #crypto: CryptoAdapter
  readonly #fetch: FetchLike
  readonly #registry: AuthorizationRegistry
  readonly #accountKey: string | undefined
  readonly #expirySkewMs: number
  readonly #redirectUri: string | undefined
  readonly #scopes: string[] | undefined
  readonly #extraAuthParams: Record<string, string> | undefined

  /** Guarantees concurrent callers share one refresh instead of racing. */
  #refreshInFlight: Promise<TokenSet> | undefined
  #cachedTokens: TokenSet | undefined
  #tokensLoaded = false

  constructor(options: AuthClientOptions) {
    const overrides: Partial<ProviderConfig> = {}

    if (options.clientId) {
      overrides.clientId = options.clientId
    }

    if (options.clientSecret) {
      overrides.clientSecret = options.clientSecret
    }

    if (options.scopes) {
      overrides.scopes = options.scopes
    }

    this.provider = resolveProvider(options.provider, overrides)

    if (!this.provider.clientId && this.provider.requiresClientId !== false) {
      const known = this.provider.id in publicClientIds
      throw new OAuthError(
        'configuration_error',
        `Provider "${this.provider.id}" needs a clientId. ` +
          (known
            ? `Pass your own, or opt into the published one: ` +
              `createAuthClient({ provider: '${this.provider.id}', clientId: publicClientIds['${this.provider.id}'] }). ` +
              'Using it presents your app as that vendor’s CLI.'
            : (this.provider.note ?? 'Pass `clientId` to createAuthClient().')),
      )
    }

    /* Providers that send no client_id (OpenRouter) still need a placeholder
       for the request builders; it is never transmitted. */
    this.#clientId = this.provider.clientId ?? this.provider.id
    this.#storage = options.storage ?? memoryStorage()
    this.#crypto = options.crypto ?? createDefaultCrypto()
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#accountKey = options.accountKey
    this.#expirySkewMs = options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS
    this.#redirectUri = options.redirectUri
    this.#scopes = options.scopes
    this.#extraAuthParams = options.extraAuthParams
    this.#registry = new AuthorizationRegistry({
      storage: this.#storage,
      ...(options.stateTtlMs !== undefined ? { ttlMs: options.stateTtlMs } : {}),
    })
  }

  get #tokenKey(): string {
    return `${TOKENS_PREFIX}${this.provider.id}${this.#accountKey ? `:${this.#accountKey}` : ''}`
  }


  /**
   * Starts a flow: mints `state`, derives a PKCE pair, persists both, and
   * returns the URL to send the user to.
   */
  async createAuthorization(options: CreateAuthorizationOptions = {}): Promise<CreatedAuthorization> {
    const redirectUri =
      options.redirectUri ?? this.#redirectUri ?? defaultRedirectUri(this.provider)

    if (!redirectUri) {
      throw new OAuthError(
        'configuration_error',
        `No redirect URI for provider "${this.provider.id}". Pass one to ` +
          'createAuthorization(), set it on the client, or use a receiver that provides one.',
      )
    }

    const state = createRandomString(this.#crypto)
    const pkce = this.provider.usePkce
      ? await createPkce(this.#crypto, this.provider.pkceMethod)
      : undefined

    await this.#registry.create({
      state,
      provider: this.provider.id,
      redirectUri,
      ...(pkce ? { codeVerifier: pkce.verifier } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    })

    const url = buildAuthorizationUrl({
      provider: this.provider,
      clientId: this.#clientId,
      redirectUri,
      state,
      ...(pkce ? { codeChallenge: pkce.challenge, codeChallengeMethod: pkce.method } : {}),
      ...(options.scopes ?? this.#scopes ? { scopes: options.scopes ?? this.#scopes } : {}),
      extraParams: { ...this.#extraAuthParams, ...options.extraParams },
    })

    return { url, state, redirectUri, ...(pkce ? { codeVerifier: pkce.verifier } : {}) }
  }

  /**
   * Finishes the flow for a `state` and returns its tokens.
   *
   * Accepts either an explicit `code`/`state` pair or a raw `callbackUrl`, so
   * an HTTP handler can pass `req.url` straight through. Also notifies anyone
   * blocked in {@link waitForAuthorization} for the same `state`.
   *
   * Providers that never echo `state` (OpenRouter) resolve against the most
   * recently started flow instead, that being the only correlation available.
   */
  async completeAuthorization(input: CompleteAuthorizationInput): Promise<TokenSet> {
    let { code, state } = input

    if (input.callbackUrl) {
      const parse = this.provider.parseCallback ?? parseStandardCallback
      const parsed = parse(input.callbackUrl)

      if (parsed.error) {
        const error = new OAuthError(
          'authorization_denied',
          `Authorization denied: ${parsed.errorDescription ?? parsed.error}`,
          {
            providerError: parsed.error,
            ...(parsed.errorDescription ? { providerErrorDescription: parsed.errorDescription } : {}),
            ...(parsed.state ? { state: parsed.state } : {}),
          },
        )

        if (parsed.state) {
          this.#registry.reject(parsed.state, error)
        }

        throw error
      }

      code = parsed.code ?? code
      state = parsed.state ?? state
    }

    if (!code) {
      throw new OAuthError('invalid_token_response', 'No authorization code supplied.')
    }

    if (!state && this.provider.echoesState === false) {
      const pending = await this.#registry.consumeLatest(this.provider.id)
      const tokens = await exchangeCode({
        provider: this.provider,
        clientId: this.#clientId,
        code,
        redirectUri: pending.redirectUri,
        ...(pending.codeVerifier ? { codeVerifier: pending.codeVerifier } : {}),
        fetchImpl: this.#fetch,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      await this.setTokens(tokens)
      this.#registry.resolve(pending.state, tokens)

      return tokens
    }

    if (!state) {
      throw new OAuthError(
        'state_mismatch',
        'No state supplied. Pass the state returned by createAuthorization().',
      )
    }

    try {
      const pending = await this.#registry.consume(state)
      const tokens = await exchangeCode({
        provider: this.provider,
        clientId: this.#clientId,
        code,
        redirectUri: pending.redirectUri,
        ...(pending.codeVerifier ? { codeVerifier: pending.codeVerifier } : {}),
        state,
        fetchImpl: this.#fetch,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      await this.setTokens(tokens)
      this.#registry.resolve(state, tokens)

      return tokens
    } catch (error) {
      this.#registry.reject(state, error)
      throw error
    }
  }

  /**
   * Blocks until the flow for `state` completes — the "give me the token for
   * this request" primitive. Pair with {@link createAuthorization} when the
   * callback lands somewhere else in your process.
   */
  waitForAuthorization(
    state: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<TokenSet> {
    return this.#registry.waitFor(state, options)
  }

  /** Reads a pending authorization without consuming it. */
  getPendingAuthorization(state: string): Promise<PendingAuthorization | undefined> {
    return this.#registry.get(state)
  }

  /** Abandons a started flow. */
  async cancelAuthorization(state: string): Promise<void> {
    await this.#registry.delete(state)
    this.#registry.reject(state, new OAuthError('aborted', `Authorization "${state}" was cancelled.`, { state }))
  }


  /**
   * Runs an entire login through a receiver and returns the tokens.
   *
   * A callback carrying no `state` is rejected rather than waved through:
   * anyone can reach a loopback port or post to an opener, so omitting the
   * parameter must not become a way to skip the check. Only providers that
   * documented they never echo it are exempt, and those correlate on the most
   * recently started flow instead, with the caveats on `echoesState`. The
   * comparison itself is constant-time, because `callback.state` is attacker
   * controlled.
   */
  async login(options: LoginOptions): Promise<TokenSet> {
    const context = {
      provider: this.provider,
      ...(options.openUrl ? { openUrl: options.openUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }
    const started = await options.receiver.start(context)

    try {
      const authorization = await this.createAuthorization({
        redirectUri: started.redirectUri,
        ...(options.scopes ? { scopes: options.scopes } : {}),
        ...(options.extraParams ? { extraParams: options.extraParams } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      })

      await started.present(authorization.url)

      const deadline = this.#rejectOnSignal(options.signal, options.timeoutMs)
      let callback: CallbackResult

      try {
        callback = await Promise.race([started.wait(), deadline.promise])
      } finally {
        deadline.cancel()
      }

      if (this.provider.echoesState !== false) {
        if (!callback.state) {
          throw new OAuthError(
            'state_mismatch',
            'The callback carried no `state`, so it cannot be matched to the ' +
              'login we started. Treating it as forged.',
            { state: authorization.state },
          )
        }

        if (!timingSafeEqual(callback.state, authorization.state)) {
          throw new OAuthError(
            'state_mismatch',
            'Callback state did not match the value we issued (possible CSRF).',
            { state: authorization.state },
          )
        }
      }

      return await this.completeAuthorization({
        code: callback.code,
        state: authorization.state,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } finally {
      await started.close()
    }
  }

  /**
   * Device flow, for boxes with no reachable browser.
   *
   * RFC 8628 unless the provider supplies its own — OpenAI's shares the shape
   * but none of the wire format.
   */
  async deviceLogin(options: DeviceLoginOptions): Promise<TokenSet> {
    const custom = this.provider.deviceFlow

    const device = custom
      ? await custom.start({
          provider: this.provider,
          clientId: this.#clientId,
          ...(options.scopes ? { scopes: options.scopes } : {}),
          fetchImpl: this.#fetch,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : await startDeviceAuthorization({
          provider: this.provider,
          clientId: this.#clientId,
          ...(options.scopes ? { scopes: options.scopes } : {}),
          fetchImpl: this.#fetch,
          crypto: this.#crypto,
          ...(options.signal ? { signal: options.signal } : {}),
        })
    await options.onCode(device)

    const poll = custom ? custom.poll : pollDeviceToken
    const tokens = await poll({
      provider: this.provider,
      clientId: this.#clientId,
      device,
      fetchImpl: this.#fetch,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    await this.setTokens(tokens)

    return tokens
  }

  /**
   * The losing half of the login race.
   *
   * Returns a `cancel` alongside the promise because the winner leaves this one
   * pending forever: without releasing the timer and the abort listener, every
   * login would strand both until the timeout elapsed, and a long-lived signal
   * would accumulate one listener per attempt.
   */
  #rejectOnSignal(
    signal?: AbortSignal,
    timeoutMs?: number,
  ): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined

    const promise = new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new OAuthError('aborted', 'Login was aborted.'))

        return
      }

      if (signal) {
        onAbort = () => reject(new OAuthError('aborted', 'Login was aborted.'))
        signal.addEventListener('abort', onAbort, { once: true })
      }

      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => reject(new OAuthError('timeout', `Login timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        )
        ;(timer as { unref?: () => void }).unref?.()
      }
    })

    return {
      promise,
      cancel: () => {
        if (timer) {
          clearTimeout(timer)
        }

        if (onAbort) {
          signal?.removeEventListener('abort', onAbort)
        }
      },
    }
  }


  /** Reads straight from storage, ignoring the in-memory cache. */
  async #readStoredTokens(): Promise<TokenSet | undefined> {
    const stored = await this.#storage.get(this.#tokenKey)

    if (!stored) {
      return undefined
    }

    try {
      return JSON.parse(stored) as TokenSet
    } catch {
      return undefined
    }
  }

  async getTokens(): Promise<TokenSet | undefined> {
    if (this.#tokensLoaded) {
      return this.#cachedTokens
    }

    this.#cachedTokens = await this.#readStoredTokens()
    this.#tokensLoaded = true

    return this.#cachedTokens
  }

  async setTokens(tokens: TokenSet): Promise<void> {
    this.#cachedTokens = tokens
    this.#tokensLoaded = true
    await this.#storage.set(this.#tokenKey, JSON.stringify(tokens))
  }

  /** True when a token exists and has not passed the renewal window. */
  async isAuthenticated(): Promise<boolean> {
    const tokens = await this.getTokens()

    return tokens !== undefined && !isExpired(tokens, this.#expirySkewMs)
  }

  /**
   * The everyday call: a valid access token, refreshed transparently.
   *
   * Concurrent callers share a single refresh — without that, ten parallel API
   * calls waking to an expired token would fire ten refreshes, and providers
   * that rotate refresh tokens would invalidate each other's.
   */
  async getAccessToken(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    const tokens = await this.getTokens()

    if (!tokens) {
      throw new OAuthError(
        'refresh_failed',
        `Not authenticated with "${this.provider.id}". Run the login flow first.`,
      )
    }

    if (!options.forceRefresh && !isExpired(tokens, this.#expirySkewMs)) {
      return tokens.accessToken
    }

    const refreshed = await this.refresh(options)

    return refreshed.accessToken
  }

  /**
   * Forces a refresh. Deduped across concurrent callers.
   *
   * Note that joining an in-flight refresh means joining its cancellation too:
   * a later caller's `signal` is not attached, and the first caller's abort
   * fails everyone. That is the trade for never issuing two refreshes at once.
   *
   * Storage is re-read before refreshing because another *process* may have
   * refreshed since. Two CLI windows racing is ordinary, and with providers
   * that rotate refresh tokens the loser's token is already dead — so take the
   * stored one if it is usable. `#refreshInFlight` covers in-process
   * concurrency; this covers the cross-process case, which no promise can.
   */
  async refresh(options: { signal?: AbortSignal } = {}): Promise<TokenSet> {
    if (this.#refreshInFlight) {
      return this.#refreshInFlight
    }

    const run = (async () => {
      const tokens = await this.getTokens()

      if (!tokens) {
        throw new OAuthError('refresh_failed', `No tokens stored for "${this.provider.id}".`)
      }

      const stored = await this.#readStoredTokens()

      if (
        stored &&
        stored.accessToken !== tokens.accessToken &&
        !isExpired(stored, this.#expirySkewMs)
      ) {
        this.#cachedTokens = stored
        this.#tokensLoaded = true

        return stored
      }

      const refreshed = await refreshTokens({
        provider: this.provider,
        clientId: this.#clientId,
        tokens,
        fetchImpl: this.#fetch,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      await this.setTokens(refreshed)

      return refreshed
    })()

    this.#refreshInFlight = run

    try {
      return await run
    } finally {
      this.#refreshInFlight = undefined
    }
  }

  /**
   * `Authorization` header value, refreshing first if needed.
   *
   * The token is fetched before the type is read, because a refresh replaces
   * the whole token set — reading the type first would pair the old one with
   * the new token.
   */
  async authorizationHeader(): Promise<string> {
    const accessToken = await this.getAccessToken()
    const tokens = await this.getTokens()

    return `${tokens?.tokenType ?? 'Bearer'} ${accessToken}`
  }

  /**
   * Revokes a token at the provider (RFC 7009).
   *
   * Revoking the refresh token is what ends the session; revoking only the
   * access token leaves this client able to mint a new one.
   *
   * This talks to the provider and nothing else — the local token stays in
   * storage, so `isAuthenticated()` keeps returning true until you clear it.
   * Use {@link logout} with `{ revoke: true }` to do both.
   */
  async revoke(
    options: { tokenType?: RevocableTokenType; signal?: AbortSignal } = {},
  ): Promise<void> {
    const tokens = await this.getTokens()

    if (!tokens) {
      return
    }

    await revokeToken({
      provider: this.provider,
      clientId: this.#clientId,
      tokens,
      ...(options.tokenType ? { tokenType: options.tokenType } : {}),
      fetchImpl: this.#fetch,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  /**
   * Clears stored tokens for this provider/account.
   *
   * Pass `{ revoke: true }` to also tell the provider, where it supports it.
   * Local state is cleared either way — a failed revocation must not leave the
   * user apparently still signed in.
   */
  async logout(options: { revoke?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (options.revoke && this.provider.revocationUrl) {
      try {
        await this.revoke(options.signal ? { signal: options.signal } : {})
      } catch {
        /* fall through — clearing local tokens still has to happen */
      }
    }

    this.#cachedTokens = undefined
    this.#tokensLoaded = true
    await this.#storage.delete(this.#tokenKey)
  }
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  return new AuthClient(options)
}
