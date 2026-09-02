import {
  createAuthClient,
  createAuthStore,
  type AuthClient,
  type AuthClientOptions,
  type AuthState,
  type CallbackReceiver,
  type LogoutResult,
  type TokenSet,
} from '@ai-oauth-sdk/core'

export * from '@ai-oauth-sdk/core'

export interface CreateAuthOptions extends AuthClientOptions {
  /** Receiver used by {@link SvelteAuthStore.login}. */
  receiver?: CallbackReceiver
  /** Load any persisted session immediately. Default true. */
  restoreOnMount?: boolean
  onSuccess?: (tokens: TokenSet) => void
  onError?: (error: unknown) => void
}

/**
 * A Svelte store (`$auth` works) with the auth actions attached.
 *
 * The core store already satisfies Svelte's contract — `subscribe(fn)` emits
 * the current value immediately and returns an unsubscribe function — so this
 * package is mostly a re-export with Svelte's types spelled out.
 */
export interface SvelteAuthStore {
  subscribe(listener: (state: AuthState) => void): () => void
  readonly client: AuthClient
  login: (overrides?: { receiver?: CallbackReceiver; scopes?: string[] }) => Promise<TokenSet | undefined>
  /** Clears the session, reporting what revocation actually did. */
  logout: (options?: { revoke?: boolean }) => Promise<LogoutResult>
  refresh: () => Promise<TokenSet | undefined>
  getAccessToken: () => Promise<string>
  restore: () => Promise<void>
  cancel: () => void
  destroy: () => void
}

/**
 * ```svelte
 * <script>
 *   import { createAuth } from '@ai-oauth-sdk/svelte'
 *   import { popupReceiver } from '@ai-oauth-sdk/browser'
 *   const auth = createAuth({ provider: 'openai', clientId, receiver: popupReceiver() })
 * </script>
 *
 * {#if $auth.tokens}
 *   <button on:click={() => auth.logout()}>Sign out</button>
 * {:else}
 *   <button on:click={() => auth.login()} disabled={$auth.isLoading}>Sign in</button>
 * {/if}
 * ```
 */
export function createAuth(options: CreateAuthOptions): SvelteAuthStore {
  const { receiver, restoreOnMount = true, onSuccess, onError, ...clientOptions } = options

  const store = createAuthStore({
    client: createAuthClient(clientOptions),
    ...(receiver ? { receiver } : {}),
    ...(onSuccess ? { onSuccess } : {}),
    ...(onError ? { onError } : {}),
  })

  if (restoreOnMount) {
    void store.restore()
  }

  return {
    subscribe: store.subscribe,
    client: store.client,
    login: store.login,
    logout: store.logout,
    refresh: store.refresh,
    getAccessToken: store.getAccessToken,
    restore: store.restore,
    cancel: store.cancel,
    destroy: store.destroy,
  }
}
