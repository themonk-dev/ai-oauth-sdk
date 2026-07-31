import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createAuthClient,
  createAuthStore,
  type AuthClient,
  type AuthClientOptions,
  type AuthState,
  type CallbackReceiver,
  type TokenSet,
} from '@ai-oauth-sdk/core'

export interface UseAuthOptions extends AuthClientOptions {
  /** Receiver used by {@link UseAuthResult.login}. */
  receiver?: CallbackReceiver
  /** Load any persisted session on mount. Default true. */
  restoreOnMount?: boolean
  onSuccess?: (tokens: TokenSet) => void
  onError?: (error: unknown) => void
}

export interface UseAuthResult extends AuthState {
  client: AuthClient
  login: (overrides?: { receiver?: CallbackReceiver; scopes?: string[] }) => Promise<TokenSet | undefined>
  logout: (options?: { revoke?: boolean }) => Promise<void>
  refresh: () => Promise<TokenSet | undefined>
  /** Valid access token, refreshing if needed. */
  getAccessToken: () => Promise<string>
  /** Cancels an in-flight login. */
  cancel: () => void
}

/**
 * React binding over the shared {@link createAuthStore}.
 *
 * The store owns the state machine; this hook only bridges it to React's
 * render cycle. Subscription-based rather than `useSyncExternalStore` so the
 * package still supports React 17.
 *
 * The store's identity depends only on what changes the client's behaviour;
 * rebuilding it every render would drop in-flight flows and the token cache.
 * Callbacks are read through a ref so they stay current without joining that
 * identity. `subscribe` emits immediately, so the mount effect also resyncs
 * state after a remount.
 */
export function useAuth(options: UseAuthOptions): UseAuthResult {
  const { receiver, restoreOnMount = true, onSuccess, onError, ...clientOptions } = options

  const clientKey = JSON.stringify({
    provider:
      typeof clientOptions.provider === 'string' ? clientOptions.provider : clientOptions.provider.id,
    clientId: clientOptions.clientId,
    redirectUri: clientOptions.redirectUri,
    scopes: clientOptions.scopes,
    accountKey: clientOptions.accountKey,
  })

  const latest = useRef({ clientOptions, receiver, onSuccess, onError })
  latest.current = { clientOptions, receiver, onSuccess, onError }

  const store = useMemo(
    () =>
      createAuthStore({
        client: createAuthClient(latest.current.clientOptions),
        ...(latest.current.receiver ? { receiver: latest.current.receiver } : {}),
        onSuccess: (tokens) => latest.current.onSuccess?.(tokens),
        onError: (error) => latest.current.onError?.(error),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientKey],
  )

  const [state, setState] = useState<AuthState>(() => store.getState())

  useEffect(() => {
    const unsubscribe = store.subscribe(setState)

    if (restoreOnMount) {
      void store.restore()
    }

    return () => {
      unsubscribe()
      store.cancel()
    }
  }, [store, restoreOnMount])

  const login = useCallback(
    (overrides?: { receiver?: CallbackReceiver; scopes?: string[] }) =>
      store.login({ ...(latest.current.receiver ? { receiver: latest.current.receiver } : {}), ...overrides }),
    [store],
  )
  const logout = useCallback((logoutOptions?: { revoke?: boolean }) => store.logout(logoutOptions), [store])
  const refresh = useCallback(() => store.refresh(), [store])
  const getAccessToken = useCallback(() => store.getAccessToken(), [store])
  const cancel = useCallback(() => store.cancel(), [store])

  return { ...state, client: store.client, login, logout, refresh, getAccessToken, cancel }
}
