import { OAuthError } from './errors.js'
import type { AuthStorage, PendingAuthorization, TokenSet } from './types.js'

const PENDING_PREFIX = 'pending:'
const LATEST_PREFIX = 'pending-latest:'
const DEFAULT_TTL_MS = 10 * 60 * 1000

export interface AuthorizationRegistryOptions {
  storage: AuthStorage
  /** How long a started authorization stays valid. Default 10 minutes. */
  ttlMs?: number
  /**
   * How long an unclaimed result stays buffered for a late `waitFor`.
   * Defaults to `ttlMs`.
   */
  settledTtlMs?: number
  /** Hard cap on buffered results, as a backstop. Default 1000. */
  maxSettled?: number
  /** Injectable clock, for tests. */
  now?: () => number
}

interface Waiter {
  resolve: (tokens: TokenSet) => void
  reject: (error: unknown) => void
}

/**
 * Whether a parsed record is usable as a {@link PendingAuthorization}.
 *
 * `JSON.parse` succeeding only says the text was JSON — `null`, `3`, `"s"` and
 * `[]` all parse — and casting the result was enough to make `record.expiresAt`
 * a property read on `null`, or an expiry comparison against `undefined` that
 * is false for every clock. Nothing this SDK stores under a `pending:` key
 * looks like that, so this is shape validation against a foreign writer or a
 * hand-edited store rather than against our own writes; treating a malformed
 * record as absent is the same answer the unparseable case already gets.
 */
function isPendingAuthorization(value: unknown): value is PendingAuthorization {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as PendingAuthorization).expiresAt)
  )
}

/**
 * Tracks in-flight authorizations by `state`.
 *
 * This is the piece that decouples "start a login" from "finish a login". The
 * `state` is the correlation id: whoever holds it can complete the flow or wait
 * for its result, even from a different request handler, a different component,
 * or after a full page reload — the pending record is persisted, so only the
 * in-memory waiters are process-local.
 */
export class AuthorizationRegistry {
  readonly #storage: AuthStorage
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #waiters = new Map<string, Set<Waiter>>()
  /** Results that arrived before anyone called `waitFor`. */
  readonly #settled = new Map<string, { tokens?: TokenSet; error?: unknown; at: number }>()
  readonly #settledTtlMs: number
  readonly #maxSettled: number
  /** `consume` calls still running, by state. See {@link consume}. */
  readonly #consuming = new Map<string, Promise<PendingAuthorization>>()

  constructor(options: AuthorizationRegistryOptions) {
    this.#storage = options.storage
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#settledTtlMs = options.settledTtlMs ?? this.#ttlMs
    this.#maxSettled = options.maxSettled ?? 1000
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Buffers a result for a `waitFor` that may never come.
   *
   * Most completions have no waiter — a CLI that calls `completeAuthorization`
   * directly never waits — so without expiry this map would grow once per login
   * for the lifetime of a long-running server. Entries expire, and a hard cap
   * bounds it even if the clock misbehaves — evicting from the front, since a
   * `Map` preserves insertion order and its first key is therefore the oldest.
   */
  #buffer(state: string, result: { tokens?: TokenSet; error?: unknown }): void {
    const now = this.#now()

    for (const [key, entry] of this.#settled) {
      if (now - entry.at > this.#settledTtlMs) {
        this.#settled.delete(key)
      }
    }

    while (this.#settled.size >= this.#maxSettled) {
      const oldest = this.#settled.keys().next()

      if (oldest.done) {
        break
      }

      this.#settled.delete(oldest.value)
    }

    this.#settled.set(state, { ...result, at: now })
  }

  /**
   * Persists a started flow, and writes a pointer to it as the newest one so
   * that providers which never echo `state` still have something to resolve
   * against. See {@link consumeLatest}.
   *
   * Pruning runs from here because abandoned flows are the norm, not the
   * exception — the user closes the browser or hits Ctrl-C and nothing ever
   * consumes the record. Without it, a CLI's credential file grows by one entry
   * per abandoned login, forever.
   */
  async create(
    input: Omit<PendingAuthorization, 'createdAt' | 'expiresAt'>,
  ): Promise<PendingAuthorization> {
    const createdAt = this.#now()
    const pending: PendingAuthorization = {
      ...input,
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
    }
    await this.#storage.set(PENDING_PREFIX + pending.state, JSON.stringify(pending))
    await this.#storage.set(LATEST_PREFIX + pending.provider, pending.state)
    await this.prune()

    return pending
  }

  /**
   * Deletes pending records that have passed their TTL, along with any that
   * cannot be read back as one — unparseable, or parseable but the wrong shape.
   *
   * Runs automatically on `create`. A no-op for storage backends that cannot
   * enumerate keys (SecureStore), which is acceptable: those are per-app mobile
   * stores where the volume never gets interesting.
   */
  async prune(): Promise<number> {
    if (!this.#storage.keys) {
      return 0
    }

    let removed = 0
    const now = this.#now()

    for (const key of await this.#storage.keys()) {
      if (!key.startsWith(PENDING_PREFIX)) {
        continue
      }

      const stored = await this.#storage.get(key)

      if (!stored) {
        continue
      }

      let record: PendingAuthorization | undefined

      try {
        const parsed: unknown = JSON.parse(stored)

        if (isPendingAuthorization(parsed)) {
          record = parsed
        }
      } catch {
        /* Nothing to do: an unparseable record is dropped below, as a
           malformed one is. Neither can ever be used. */
      }

      if (record === undefined || now > record.expiresAt) {
        await this.#storage.delete(key)

        if (record) {
          await this.#clearLatestPointer(record.provider, record.state)
        }

        removed++
      }
    }

    return removed
  }

  /**
   * Consumes the most recently started flow for a provider.
   *
   * Only for providers that do not echo `state` back (OpenRouter). There is no
   * CSRF guard in this path — with nothing to correlate on, the best available
   * answer is "the flow this process just started". Fine for a CLI or a
   * single-flow app; not safe for a multi-user server.
   */
  async consumeLatest(provider: string): Promise<PendingAuthorization> {
    const state = await this.#storage.get(LATEST_PREFIX + provider)

    if (!state) {
      throw new OAuthError(
        'unknown_state',
        `No pending authorization for provider "${provider}".`,
      )
    }

    return this.consume(state)
  }

  /** Reads a pending authorization without consuming it. */
  async get(state: string): Promise<PendingAuthorization | undefined> {
    const stored = await this.#storage.get(PENDING_PREFIX + state)

    if (!stored) {
      return undefined
    }

    try {
      const parsed: unknown = JSON.parse(stored)

      return isPendingAuthorization(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Drops the "newest flow" pointer when it still names `state`.
   *
   * Left behind, it outlives the record it points at — so a later
   * `consumeLatest` would chase a state that no longer exists, and every
   * completed login would strand a key in the store.
   */
  async #clearLatestPointer(provider: string, state: string): Promise<void> {
    if ((await this.#storage.get(LATEST_PREFIX + provider)) === state) {
      await this.#storage.delete(LATEST_PREFIX + provider)
    }
  }

  /**
   * Reads and removes a pending authorization. Single-use by design: replaying
   * a `state` must not replay the code exchange.
   *
   * Single-use *sequentially* was all the read-then-delete gave: the read is two
   * awaits into storage, so callers arriving together all saw the record before
   * any of them deleted it and all were handed the same `codeVerifier`. Calls
   * for one state are now serialised — a later arrival waits for the one in
   * flight and then reads again, finding nothing.
   *
   * That race needs no attacker to reach. A browser resending a callback, or a
   * link scanner prefetching the redirect, is enough for two
   * `completeAuthorization` calls to post the same code and the same verifier.
   * Only one redemption can succeed at the authorization server and the
   * verifier never leaves this process, so what the duplicate costs is the
   * reuse itself: an authorization server following RFC 6749 §4.1.2 revokes
   * every token it already issued for a reused code, taking out the session the
   * first call had just established.
   *
   * In-process only, and deliberately so. `AuthStorage` has no
   * compare-and-swap, so two CLI windows sharing one `auth.json` can still both
   * read the record before either deletes it. Closing that needs an atomic
   * primitive on the storage interface, which is a much larger change than this
   * defect justifies.
   */
  async consume(state: string): Promise<PendingAuthorization> {
    const inFlight = this.#consuming.get(state)

    if (inFlight) {
      // However the first call ends — consumed, expired, or thrown — the record
      // is gone once it has, so reading again reports it as already used.
      await inFlight.catch(() => {})

      return this.#consumeOnce(state)
    }

    const running = this.#consumeOnce(state)
    this.#consuming.set(state, running)

    try {
      return await running
    } finally {
      this.#consuming.delete(state)
    }
  }

  async #consumeOnce(state: string): Promise<PendingAuthorization> {
    const pending = await this.get(state)

    if (!pending) {
      throw new OAuthError(
        'unknown_state',
        `No pending authorization for state "${state}". It was already used, ` +
          'expired, or was started by a client with different storage.',
        { state },
      )
    }

    await this.#storage.delete(PENDING_PREFIX + state)
    await this.#clearLatestPointer(pending.provider, state)

    if (this.#now() > pending.expiresAt) {
      throw new OAuthError('state_expired', `Authorization for state "${state}" expired.`, { state })
    }

    return pending
  }

  async delete(state: string): Promise<void> {
    const pending = await this.get(state)
    await this.#storage.delete(PENDING_PREFIX + state)

    if (pending) {
      await this.#clearLatestPointer(pending.provider, state)
    }
  }

  /**
   * Resolves once the flow for `state` completes.
   *
   * Safe to call before or after the result lands — results that arrive early
   * are buffered, so there is no race between starting the wait and the
   * callback arriving. An *expired* buffer is treated as absent: the caller
   * waits, exactly as it would have if nothing had ever been buffered.
   *
   * The timer is unreferenced so it cannot hold a CLI process open on its own,
   * and `cleanup` drops the waiter set once it empties — otherwise a server
   * that times out many waits keeps one `Map` entry per state forever.
   */
  waitFor(state: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TokenSet> {
    const alreadySettled = this.#settled.get(state)

    if (alreadySettled) {
      this.#settled.delete(state)

      if (this.#now() - alreadySettled.at <= this.#settledTtlMs) {
        if (alreadySettled.error !== undefined) {
          return Promise.reject(alreadySettled.error)
        }

        return Promise.resolve(alreadySettled.tokens as TokenSet)
      }
    }

    return new Promise<TokenSet>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const waiter: Waiter = {
        resolve: (tokens) => {
          cleanup()
          resolve(tokens)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
        }

        options.signal?.removeEventListener('abort', onAbort)
        const set = this.#waiters.get(state)
        set?.delete(waiter)

        if (set && set.size === 0) {
          this.#waiters.delete(state)
        }
      }

      const onAbort = () => {
        waiter.reject(
          new OAuthError('aborted', `Authorization for state "${state}" was aborted.`, { state }),
        )
      }

      if (options.signal?.aborted) {
        reject(new OAuthError('aborted', `Authorization for state "${state}" was aborted.`, { state }))

        return
      }

      options.signal?.addEventListener('abort', onAbort, { once: true })

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          waiter.reject(
            new OAuthError(
              'timeout',
              `Timed out after ${options.timeoutMs}ms waiting for state "${state}".`,
              { state },
            ),
          )
        }, options.timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      }

      let set = this.#waiters.get(state)

      if (!set) {
        set = new Set()
        this.#waiters.set(state, set)
      }

      set.add(waiter)
    })
  }

  /** Hands `tokens` to everyone waiting on `state`. */
  resolve(state: string, tokens: TokenSet): void {
    const waiters = this.#waiters.get(state)

    if (!waiters?.size) {
      this.#buffer(state, { tokens })

      return
    }

    this.#waiters.delete(state)

    for (const waiter of waiters) {
      waiter.resolve(tokens)
    }
  }

  /** Fails everyone waiting on `state`. */
  reject(state: string, error: unknown): void {
    const waiters = this.#waiters.get(state)

    if (!waiters?.size) {
      this.#buffer(state, { error })

      return
    }

    this.#waiters.delete(state)

    for (const waiter of waiters) {
      waiter.reject(error)
    }
  }

  /** Drops buffered results nobody claimed. Expiry handles this automatically. */
  clearSettled(): void {
    this.#settled.clear()
  }

  /** Buffered-result count. Exposed for tests and diagnostics. */
  get bufferedCount(): number {
    return this.#settled.size
  }
}
