import { createSignal, onCleanup, type Accessor } from 'solid-js'

import {
  createAuthClient,
  createAuthStore,
  type AuthClient,
  type AuthClientOptions,
  type AuthState,
  type CallbackReceiver,
  type TokenSet,
} from '@ai-oauth-sdk/core'

export * from '@ai-oauth-sdk/core'

export interface CreateAuthOptions extends AuthClientOptions {
  /** Receiver used by {@link SolidAuth.login}. */
  receiver?: CallbackReceiver
  /** Load any persisted session immediately. Default true. */
  restoreOnMount?: boolean
  onSuccess?: (tokens: TokenSet) => void
  onError?: (error: unknown) => void
}

export interface SolidAuth {
  client: AuthClient
  tokens: Accessor<TokenSet | undefined>
  isAuthenticated: Accessor<boolean>
  isLoading: Accessor<boolean>
  error: Accessor<Error | undefined>
  login: (overrides?: { receiver?: CallbackReceiver; scopes?: string[] }) => Promise<TokenSet | undefined>
  logout: (options?: { revoke?: boolean }) => Promise<void>
  refresh: () => Promise<TokenSet | undefined>
  getAccessToken: () => Promise<string>
  cancel: () => void
}

/**
 * Solid primitive over the shared auth store.
 *
 * ```tsx
 * const auth = createAuth({ provider: 'openai', clientId, receiver: popupReceiver() })
 * return <Show when={auth.tokens()} fallback={<button onClick={() => auth.login()}>Sign in</button>}>
 *   <button onClick={() => auth.logout()}>Sign out</button>
 * </Show>
 * ```
 */
export function createAuth(options: CreateAuthOptions): SolidAuth {
  const { receiver, restoreOnMount = true, onSuccess, onError, ...clientOptions } = options

  const store = createAuthStore({
    client: createAuthClient(clientOptions),
    ...(receiver ? { receiver } : {}),
    ...(onSuccess ? { onSuccess } : {}),
    ...(onError ? { onError } : {}),
  })

  const initial = store.getState()
  // `equals: false` is unnecessary here: the store already suppresses no-op
  // notifications, and TokenSet is replaced wholesale rather than mutated.
  const [tokens, setTokens] = createSignal<TokenSet | undefined>(initial.tokens)
  const [isLoading, setIsLoading] = createSignal(initial.isLoading)
  const [error, setError] = createSignal<Error | undefined>(initial.error)

  const apply = (state: AuthState) => {
    setTokens(() => state.tokens)
    setIsLoading(state.isLoading)
    setError(() => state.error)
  }

  const unsubscribe = store.subscribe(apply)
  if (restoreOnMount) {
    void store.restore()
  }

  // No-op outside a reactive root, which is the correct behaviour there.
  onCleanup(() => {
    unsubscribe()
    store.destroy()
  })

  return {
    client: store.client,
    tokens,
    isAuthenticated: () => tokens() !== undefined,
    isLoading,
    error,
    login: (overrides) => store.login(overrides),
    logout: (logoutOptions) => store.logout(logoutOptions),
    refresh: () => store.refresh(),
    getAccessToken: () => store.getAccessToken(),
    cancel: () => store.cancel(),
  }
}
