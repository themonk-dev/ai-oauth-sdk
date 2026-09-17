import { computed, onScopeDispose, readonly, ref, shallowRef, type ComputedRef, type Ref } from 'vue'

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

export interface UseAuthOptions extends AuthClientOptions {
  /** Receiver used by {@link UseAuthResult.login}. */
  receiver?: CallbackReceiver
  /** Load any persisted session immediately. Default true. */
  restoreOnMount?: boolean
  onSuccess?: (tokens: TokenSet) => void
  onError?: (error: unknown) => void
}

export interface UseAuthResult {
  client: AuthClient
  tokens: Readonly<Ref<TokenSet | undefined>>
  isAuthenticated: ComputedRef<boolean>
  isLoading: Readonly<Ref<boolean>>
  error: Readonly<Ref<Error | undefined>>
  login: (overrides?: { receiver?: CallbackReceiver; scopes?: string[] }) => Promise<TokenSet | undefined>
  /** Clears the session, reporting what revocation actually did. */
  logout: (options?: { revoke?: boolean }) => Promise<LogoutResult>
  refresh: () => Promise<TokenSet | undefined>
  getAccessToken: () => Promise<string>
  cancel: () => void
}

/**
 * Vue 3 composable over the shared auth store.
 *
 * Cleans itself up through `onScopeDispose`, so it works inside `setup()`, a
 * detached `effectScope()`, or a Pinia store without leaking the subscription —
 * and is a no-op outside a component or effect scope, which is exactly right.
 *
 * `shallowRef` is enough for the token: a `TokenSet` is replaced wholesale and
 * never mutated in place, so deep reactivity would only cost proxy overhead.
 */
export function useAuth(options: UseAuthOptions): UseAuthResult {
  const { receiver, restoreOnMount = true, onSuccess, onError, ...clientOptions } = options

  const store = createAuthStore({
    client: createAuthClient(clientOptions),
    ...(receiver ? { receiver } : {}),
    ...(onSuccess ? { onSuccess } : {}),
    ...(onError ? { onError } : {}),
  })

  const tokens = shallowRef<TokenSet | undefined>(undefined)
  const isLoading = ref(false)
  const error = shallowRef<Error | undefined>(undefined)

  const apply = (state: AuthState) => {
    tokens.value = state.tokens
    isLoading.value = state.isLoading
    error.value = state.error
  }

  const unsubscribe = store.subscribe(apply)

  if (restoreOnMount) {
    void store.restore()
  }

  onScopeDispose(() => {
    unsubscribe()
    store.destroy()
  })

  return {
    client: store.client,
    tokens: readonly(tokens) as Readonly<Ref<TokenSet | undefined>>,
    isAuthenticated: computed(() => tokens.value !== undefined),
    isLoading: readonly(isLoading),
    error: readonly(error) as Readonly<Ref<Error | undefined>>,
    login: (overrides) => store.login(overrides),
    logout: (logoutOptions) => store.logout(logoutOptions),
    refresh: () => store.refresh(),
    getAccessToken: () => store.getAccessToken(),
    cancel: () => store.cancel(),
  }
}
