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
        /* Same reading as in `login`: a refresh the client abandoned because
           the user signed out mid-flight is a user action, not a failure to
           put in front of them. */
        if (isOAuthError(caught) && caught.code === 'aborted') {
          setState({ isLoading: false })

          return undefined
        }

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
