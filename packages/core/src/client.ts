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
 * The origin a provider's tokens are minted at, which is what a stored record
 * is stamped with and later compared against.
 *
 * The origin rather than the whole URL: a provider moving `/oauth/token` to
 * `/v2/token` is a routine deployment and is still the same issuer, while a
 * different origin never is. Unparseable yields `undefined`, so a descriptor
 * with a malformed `tokenUrl` — which can never complete an exchange anyway —
 * stamps nothing rather than stamping garbage.
 */
function tokenEndpointOriginOf(tokenUrl: string): string | undefined {
  try {
    return new URL(tokenUrl).origin
  } catch {
    return undefined
  }
}

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
  /** Stamped onto everything this client persists. See {@link tokenEndpointOriginOf}. */
  readonly #tokenEndpointOrigin: string | undefined

  /** Guarantees concurrent callers share one refresh instead of racing. */
  #refreshInFlight: Promise<TokenSet> | undefined
  #cachedTokens: TokenSet | undefined
  #tokensLoaded = false
  /**
   * Bumped by {@link logout}. A refresh that captured an earlier value has been
   * disowned since it started, and must not write what it comes back with.
   */
  #generation = 0

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
    this.#tokenEndpointOrigin = tokenEndpointOriginOf(this.provider.tokenUrl)
    this.#registry = new AuthorizationRegistry({
      storage: this.#storage,
      ...(options.stateTtlMs !== undefined ? { ttlMs: options.stateTtlMs } : {}),
    })
  }

  get #tokenKey(): string {
    return this.#keyFor(this.provider.id)
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
      ...(this.#tokenEndpointOrigin ? { tokenEndpointOrigin: this.#tokenEndpointOrigin } : {}),
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
   * True when a record written under `providerId` belongs to this provider —
   * its current id, or one it used to have.
   *
   * Renamed providers are still the same issuer, so a flow started under an old
   * id has to keep completing across the upgrade that renamed it, and a
   * credential stored under one has to keep being found. This is the single
   * test behind both allowances; {@link AuthClient.#readRenamedTokens} makes
   * the storage half.
   *
   * The current id is taken on the name alone, because that key is this
   * client's own. A *previous* id is not: it is a name the provider let go of,
   * and anything can pick a shed name up — a descriptor built with
   * `defineProvider({ id: 'anthropic' })`, or `ai-oauth-sdk login anthropic
   * --token-url …` from the shipped CLI, which reserved the current ids and not
   * the shed ones. Honouring such a record on the name alone hands a different
   * issuer whatever the genuine one stored: a refresh token POSTed to their
   * endpoint under our client id, or a live `code` and `code_verifier`
   * exchanged there.
   *
   * So a previous id has to agree on the token endpoint as well. Records
   * carrying no origin are the ones written by the version that still used the
   * old id — exactly the rename this allowance exists for — and are accepted,
   * which is also what keeps an upgrade from signing everybody out.
   */
  #ownsProviderId(providerId: string, tokenEndpointOrigin?: string): boolean {
    if (providerId === this.provider.id) {
      return true
    }

    if (!(this.provider.previousIds ?? []).includes(providerId)) {
      return false
    }

    return tokenEndpointOrigin === undefined || tokenEndpointOrigin === this.#tokenEndpointOrigin
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

      /* Pending records are keyed by `state` alone, and one storage is
         routinely shared by every client an app builds — so a callback routed
         to the wrong client would otherwise post *that* flow's code, PKCE
         verifier and redirect URI to this provider's token endpoint, under this
         provider's client id. Mis-routing the callback is an application bug,
         most easily made on a single shared `/callback` page that must pick a
         client before it knows whose `state` it is holding; the guard is here
         so the bug cannot turn into the mix-up attack of OAuth 2.0 Security BCP
         §4.4, where the response is not bound to the issuer it came from and a
         live credential leaves the process before anything rejects it.

         The record has already been consumed, and stays consumed: a callback
         that reached the wrong client must not be replayable at the right one.
         `consumeLatest` was provider-scoped from the start; this is the same
         rule on the `state`-keyed path. */
      if (!this.#ownsProviderId(pending.provider, pending.tokenEndpointOrigin)) {
        throw new OAuthError(
          'state_mismatch',
          `Pending authorization for state "${state}" belongs to provider ` +
            `"${pending.provider}", not "${this.provider.id}".`,
          { state },
        )
      }

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
  #keyFor(providerId: string): string {
    return `${TOKENS_PREFIX}${providerId}${this.#accountKey ? `:${this.#accountKey}` : ''}`
  }

  async #readStoredTokens(): Promise<TokenSet | undefined> {
    const stored =
      (await this.#storage.get(this.#tokenKey)) ?? (await this.#readRenamedTokens())

    if (!stored) {
      return undefined
    }

    try {
      return JSON.parse(stored) as TokenSet
    } catch {
      return undefined
    }
  }

  /**
   * Finds tokens saved under an id this provider used to have, and moves them
   * to the current key so the lookup only happens once.
   *
   * Only a record {@link AuthClient.#ownsProviderId} vouches for is taken: a
   * shed id is a name anyone can claim, and a credential minted somewhere else
   * under that name must be left where it is rather than adopted, moved onto
   * this provider's key and refreshed against this provider's endpoint. One
   * that is refused is not deleted either — it is not ours to tidy.
   *
   * The move is best-effort: a storage backend that cannot delete, or throws on
   * write, still hands back the credential it found.
   */
  async #readRenamedTokens(): Promise<string | null> {
    for (const previousId of this.provider.previousIds ?? []) {
      const key = this.#keyFor(previousId)
      const stored = await this.#storage.get(key)

      if (!stored || !this.#ownsStoredTokens(stored, previousId)) {
        continue
      }

      try {
        await this.#storage.set(this.#tokenKey, stored)
        await this.#storage.delete(key)
      } catch {
        /* the credential is what matters; tidying the old key is not */
      }

      return stored
    }

    return null
  }

  /**
   * Whether a record found at `previousId`'s key is one this provider may
   * adopt. Unparseable is not: it can never be used as a credential, and
   * nothing is learned from it that would justify moving it.
   */
  #ownsStoredTokens(stored: string, previousId: string): boolean {
    let record: TokenSet

    try {
      record = JSON.parse(stored) as TokenSet
    } catch {
      return false
    }

    return this.#ownsProviderId(previousId, record.tokenEndpointOrigin)
  }

  async getTokens(): Promise<TokenSet | undefined> {
    if (this.#tokensLoaded) {
      return this.#cachedTokens
    }

    this.#cachedTokens = await this.#readStoredTokens()
    this.#tokensLoaded = true

    return this.#cachedTokens
  }

  /**
   * Writes a token set, stamped with the endpoint it belongs to.
   *
   * The stamp is what lets a later client tell a credential this provider
   * minted from one that merely sits under a name it answers to; see
   * {@link AuthClient.#ownsProviderId}. It is recorded on the way to storage
   * rather than by whoever built the token set, so a caller migrating
   * credentials in gets it for free.
   */
  async setTokens(tokens: TokenSet): Promise<void> {
    const record: TokenSet = this.#tokenEndpointOrigin
      ? { ...tokens, tokenEndpointOrigin: this.#tokenEndpointOrigin }
      : tokens
    this.#cachedTokens = record
    this.#tokensLoaded = true
    await this.#storage.set(this.#tokenKey, JSON.stringify(record))
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
   *
   * A sign-out that lands mid-flight wins: see {@link AuthClient.#assertNotSignedOut}.
   */
  async refresh(options: { signal?: AbortSignal } = {}): Promise<TokenSet> {
    if (this.#refreshInFlight) {
      return this.#refreshInFlight
    }

    const generation = this.#generation

    const run = (async () => {
      const tokens = await this.getTokens()

      if (!tokens) {
        throw new OAuthError('refresh_failed', `No tokens stored for "${this.provider.id}".`)
      }

      const stored = await this.#readStoredTokens()
      this.#assertNotSignedOut(generation)

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
      this.#assertNotSignedOut(generation)
      await this.setTokens(refreshed)

      return refreshed
    })()

    this.#refreshInFlight = run

    try {
      return await run
    } finally {
      /* Only if it is still ours: `logout()` drops the slot, so a refresh
         started after the sign-out owns it by the time this one settles. */
      if (this.#refreshInFlight === run) {
        this.#refreshInFlight = undefined
      }
    }
  }

  /**
   * Fails a refresh that was signed out from under it.
   *
   * `logout()` clears the cache and deletes the record, but a token request
   * already dispatched cannot be recalled, and a rotating provider answers it
   * with a fresh access *and* refresh token a round trip later. Writing that
   * would put the session back — in memory and on disk, so the next process
   * over the same store reads a credential the user signed out of, and nothing
   * downstream ever heals it. Under `{ revoke: true }` it is worse than a
   * stale record: the revocation went to the token the response has just
   * replaced, and RFC 7009 §2.1 only *recommends* that revoking one of a pair
   * cascades to the other, so on a provider that rotates without cascading the
   * new token stays live at the provider as well as on disk.
   *
   * Rejecting rather than returning the token is the same decision as not
   * writing it: a caller must not be handed a credential this client has
   * disowned. `aborted` because that is what it is — the caller's own
   * `logout()` cancelled the work, exactly as a `signal` would have.
   */
  #assertNotSignedOut(generation: number): void {
    if (generation === this.#generation) {
      return
    }

    throw new OAuthError(
      'aborted',
      `Refresh for "${this.provider.id}" was discarded: the session was signed out while it ran.`,
    )
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
   *
   * A refresh already in flight is disowned rather than waited for. It cannot
   * be recalled, so signing out is recorded as a generation the run no longer
   * belongs to and its result is discarded when it lands; dropping the shared
   * promise as well keeps a `getAccessToken()` issued after the sign-out from
   * joining a run whose result is now unusable. This method still does not
   * await the network and still cannot throw on its own account.
   */
  async logout(options: { revoke?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (options.revoke && this.provider.revocationUrl) {
      try {
        await this.revoke(options.signal ? { signal: options.signal } : {})
      } catch {
        /* fall through — clearing local tokens still has to happen */
      }
    }

    this.#generation++
    this.#refreshInFlight = undefined
    this.#cachedTokens = undefined
    this.#tokensLoaded = true
    await this.#storage.delete(this.#tokenKey)
  }
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  return new AuthClient(options)
}
