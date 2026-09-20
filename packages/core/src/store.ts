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
        // `error: undefined` explicitly: `setState` merges, so a failure left
        // in state by anything else would otherwise still be showing beside a
        // set of tokens that just arrived.
        setState({ tokens, isLoading: false, error: undefined })
        options.onSuccess?.(tokens)

        return tokens
      } catch (caught) {
        // A superseded login publishes nothing at all.
        //
        // Login #2 has already set `isLoading: true` by the time #1's rejection
        // lands here, so an unguarded `isLoading: false` reports idle in the
        // middle of a live login — and a UI rendering its button on
        // `!isLoading && !isAuthenticated` puts "Sign in" back in front of the
        // user. Worse when the discarded attempt fails for a real reason rather
        // than by abort, which is what clicking Deny in the superseded popup
        // does: the branches below would write that error into the state and
        // call `onError` on behalf of a login nobody is waiting on, and since
        // the success path above merges rather than replaces, the store could
        // settle as authenticated with a dead login's error still in
        // `state.error`.
        //
        // Same identity test the `finally` below already uses. A rejection
        // arriving after #2 has finished finds `abortController` cleared to
        // `undefined`, so it short-circuits here too.
        if (abortController !== controller) {
          return undefined
        }

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
