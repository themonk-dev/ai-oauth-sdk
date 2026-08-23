import { isOAuthError } from './errors.js'
import type { AuthClient } from './client.js'
import type { CallbackReceiver, TokenSet } from './types.js'

export interface AuthState {
  tokens: TokenSet | undefined
  isAuthenticated: boolean
  /** True while a login, refresh or restore is in flight. */
  isLoading: boolean
  error: Error | undefined
}

export interface AuthStoreOptions {
  client: AuthClient
  /** Receiver used by {@link AuthStore.login} when none is passed per-call. */
  receiver?: CallbackReceiver
  onSuccess?: (tokens: TokenSet) => void
  onError?: (error: unknown) => void
}

export interface LoginOverrides {
  receiver?: CallbackReceiver
  scopes?: string[]
}

/**
 * A framework-agnostic observable wrapper around {@link AuthClient}.
 *
 * Every UI binding in this repo — React, Vue, Svelte, Solid — is a thin
 * adapter over this, so the state machine (loading flags, error handling,
 * cancellation, restore-on-start) exists once rather than four times.
 *
 * `subscribe` follows the Svelte store contract: it calls the listener
 * immediately with the current state and returns an unsubscribe function. That
 * contract also happens to suit React, Vue and Solid, so nothing else needs a
 * bespoke shape — `subscribe` emits the current value immediately, as that
 * contract requires.
 *
 * Notifications are skipped when nothing actually moved, so bindings that map
 * state straight onto reactive primitives do not re-render for free. A second
 * `login` supersedes the first rather than racing it, and an abort is treated
 * as a user action rather than an error worth surfacing in the UI.
 */
export interface AuthStore {
  readonly client: AuthClient
  getState(): AuthState
  subscribe(listener: (state: AuthState) => void): () => void
  /** Loads any persisted session. Safe to call more than once. */
  restore(): Promise<void>
  login(overrides?: LoginOverrides): Promise<TokenSet | undefined>
  /**
   * Signs out, aborting any in-flight login first so it cannot write a fresh
   * credential back over the sign-out.
   */
  logout(options?: { revoke?: boolean }): Promise<void>
  refresh(): Promise<TokenSet | undefined>
  getAccessToken(): Promise<string>
  /** Aborts an in-flight login. */
  cancel(): void
  /** Releases listeners and aborts anything pending. */
  destroy(): void
}

export function createAuthStore(options: AuthStoreOptions): AuthStore {
  const { client } = options

  let state: AuthState = {
    tokens: undefined,
    isAuthenticated: false,
    isLoading: false,
    error: undefined,
  }

  const listeners = new Set<(state: AuthState) => void>()
  let abortController: AbortController | undefined
  let destroyed = false

  const setState = (patch: Partial<AuthState>): void => {
    if (destroyed) {
      return
    }

    const next = { ...state, ...patch }
    next.isAuthenticated = next.tokens !== undefined

    if (
      next.tokens === state.tokens &&
      next.isLoading === state.isLoading &&
      next.error === state.error
    ) {
      return
    }

    state = next

    for (const listener of listeners) {
      listener(state)
    }
  }

  const toError = (caught: unknown): Error =>
    caught instanceof Error ? caught : new Error(String(caught))

  return {
    client,

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)

      return () => {
        listeners.delete(listener)
      }
    },

    async restore() {
      setState({ isLoading: true })

      try {
        setState({ tokens: await client.getTokens(), isLoading: false })
      } catch (caught) {
        setState({ isLoading: false, error: toError(caught) })
      }
    },

    async login(overrides = {}) {
      const receiver = overrides.receiver ?? options.receiver

      if (!receiver) {
        const error = new Error(
          'No receiver configured. Pass `receiver` when creating the store, or to login().',
        )
        setState({ error })
        options.onError?.(error)

        return undefined
      }

      abortController?.abort()
      const controller = new AbortController()
      abortController = controller

      setState({ isLoading: true, error: undefined })

      try {
        const tokens = await client.login({
          receiver,
          signal: controller.signal,
          ...(overrides.scopes ? { scopes: overrides.scopes } : {}),
        })
        setState({ tokens, isLoading: false })
        options.onSuccess?.(tokens)

        return tokens
      } catch (caught) {
        if (isOAuthError(caught) && caught.code === 'aborted') {
          setState({ isLoading: false })

          return undefined
        }

        setState({ isLoading: false, error: toError(caught) })
        options.onError?.(caught)

        return undefined
      } finally {
        if (abortController === controller) {
          abortController = undefined
        }
      }
    },

    async logout(logoutOptions = {}) {
      // Abort first, and before the awaited call below.
      //
      // `client.logout()` does not stop a login that is already in flight. It
      // clears the client's cached tokens and deletes the stored record, but a
      // `login()` parked on its receiver still holds a live authorization
      // attempt, and when that callback lands `completeAuthorization` writes a
      // fresh access *and* refresh token straight back to storage. The sign-out
      // is then undone durably rather than transiently: a new process over the
      // same `fileStorage()` reads the session back, `isAuthenticated()`
      // returns true, and nothing downstream heals it.
      //
      // `{ revoke: true }` is the worse half. Signed out already, `revoke()`
      // early-returns because there is nothing to read, so no revocation is
      // sent at all; signed in, it revokes the token being replaced while the
      // one that survives is written live and un-revoked. Either way the
      // credential left at rest is the one that was never revoked.
      //
      // Ordering is load-bearing, though not for the obvious reason. A login
      // that completes entirely *inside* the revoke round trip does not
      // survive: `client.logout()` deletes the stored record after revoking,
      // and that delete wipes the write. What survives is a login whose
      // `setTokens` write is ordered *after* that delete — which is what the
      // round trip buys it, by letting the attempt get past `consume()` and
      // into the token request before the logout enqueues its delete, so the
      // response lands while the delete is already executing. Aborting first
      // denies it that head start; and because the signal is threaded through
      // `completeAuthorization` into `exchangeCode`, an abort arriving any time
      // before the token response resolves stops the write outright.
      //
      // Aborting costs nothing when no login is pending, and `login()` already
      // treats an abort as a user action rather than an error, so a cancelled
      // sign-in surfaces no spurious failure in the UI.
      //
      // What this reaches is a login on *this* store instance. Shared through
      // `AuthProvider` or its equivalent, that is the whole app; two components
      // each constructing their own store hold their own controllers, and one's
      // sign-out does not reach the other's parked login. That is already the
      // anti-pattern `AuthProvider` warns against, but the limit is worth
      // stating rather than implying the store covers more than it does.
      //
      // `client.logout()` called directly and `deviceLogin()` — which the store
      // does not wrap at all — are outside this entirely and still race;
      // closing those needs the client itself to disown a run it no longer
      // owns.
      abortController?.abort()
      await client.logout(logoutOptions)
      setState({ tokens: undefined, error: undefined })
    },

    async refresh() {
      setState({ isLoading: true })

      try {
        const tokens = await client.refresh()
        setState({ tokens, isLoading: false })

        return tokens
      } catch (caught) {
        setState({ isLoading: false, error: toError(caught) })
        options.onError?.(caught)

        return undefined
      }
    },

    async getAccessToken() {
      const accessToken = await client.getAccessToken()
      const latest = await client.getTokens()

      if (latest !== state.tokens) {
        setState({ tokens: latest })
      }

      return accessToken
    },

    cancel() {
      abortController?.abort()
    },

    destroy() {
      destroyed = true
      abortController?.abort()
      listeners.clear()
    },
  }
}
