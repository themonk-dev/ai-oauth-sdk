import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createAuthClient,
  createAuthStore,
  type AuthClient,
  type AuthClientOptions,
  type AuthState,
  type AuthStore,
  type CallbackReceiver,
  type TokenSet,
} from '@ai-oauth-sdk/core'

import {
  currentBrowserOrigin,
  resolveBrowserFlow,
  type BrowserFlowResolution,
  type BrowserOrigin,
} from '@ai-oauth-sdk/browser'

export interface UseAuthOptions extends AuthClientOptions {
  /** Receiver used by {@link UseAuthResult.login}. */
  receiver?: CallbackReceiver
  /** Load any persisted session on mount. Default true. */
  restoreOnMount?: boolean
  onSuccess?: (tokens: TokenSet) => void
  onError?: (error: unknown) => void
  /**
   * Origin {@link UseAuthResult.flow} resolves against. Defaults to
   * `window.location`, read only after mount so the server and the first
   * client render agree (see `flow` below). Pass this when the deploy origin
   * is already known ahead of time — it makes `flow` available on the very
   * first render, server included — or to pin an origin in a test without
   * mocking `window.location`.
   */
  origin?: BrowserOrigin
}

export interface UseAuthResult extends AuthState {
  client: AuthClient
  /**
   * The browser sign-in flow `resolveBrowserFlow` (from `@ai-oauth-sdk/browser`)
   * picks for this provider on this origin — `popup`, `device`, or `paste`.
   * `undefined` on the server and for one render after mount on the client,
   * since there is no origin to resolve against before `window` exists (or
   * before `options.origin` is read).
   *
   * This is the *automatic* choice — what `autoReceiver()`/`autoLogin()` from
   * `@ai-oauth-sdk/browser` would run. `login()` below never consults it: it
   * always calls the `receiver` given to this hook, or to `login()` itself.
   * Supplying a custom `receiver` does not change `flow` — `resolveBrowserFlow`
   * only looks at the provider and the origin, not at what a receiver does —
   * so treat `flow` as guidance for which UI to render before `login()` runs
   * (a popup button, a device-code panel, a paste form), not as a description
   * of what a custom receiver will actually do.
   *
   * A `flow` of `'device'` cannot be driven by `login()` — see the comment
   * above it. Call `client.deviceLogin()` directly, or `autoLogin()` for the
   * full dispatch.
   */
  flow: BrowserFlowResolution | undefined
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
  const { receiver, restoreOnMount = true, onSuccess, onError, origin, ...clientOptions } = options

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

  // State is held together with the store it came from. Keeping them in one
  // value is what lets a rebuilt store discard the previous one's state during
  // the same render: held apart, the render that first returns the new store
  // still returns the old store's `tokens`, and the commit in between pairs the
  // new client's identity with the previous session's credentials on screen.
  // The subscription in the effect below would correct that, but only a frame
  // later.
  const [snapshot, setSnapshot] = useState<{ store: AuthStore; state: AuthState }>(() => ({
    store,
    state: store.getState(),
  }))

  if (snapshot.store !== store) {
    setSnapshot({ store, state: store.getState() })
  }

  const state = snapshot.store === store ? snapshot.state : store.getState()

  useEffect(() => {
    // Re-using the previous snapshot when nothing moved keeps the store's own
    // "notify only on a real change" guarantee from costing a render here.
    const unsubscribe = store.subscribe((next) => {
      setSnapshot((previous) =>
        previous.store === store && previous.state === next ? previous : { store, state: next },
      )
    })

    if (restoreOnMount) {
      void store.restore()
    }

    return () => {
      unsubscribe()
      store.cancel()
    }
  }, [store, restoreOnMount])

  // `window.location` only stands in for `origin` once mounted — reading it
  // during render would give the server and the first client render
  // different output for the same markup, which React reports as a
  // hydration mismatch. An explicit `origin` carries none of that risk (it
  // is the same plain value on both sides), so it resolves synchronously
  // below instead of waiting for this effect.
  const [autoFlow, setAutoFlow] = useState<BrowserFlowResolution | undefined>(undefined)

  useEffect(() => {
    if (origin || typeof window === 'undefined') {
      return
    }

    setAutoFlow(resolveBrowserFlow(store.client.provider, currentBrowserOrigin()))
  }, [store, origin])

  const flow = origin ? resolveBrowserFlow(store.client.provider, origin) : autoFlow

  const login = useCallback(
    (overrides?: { receiver?: CallbackReceiver; scopes?: string[] }) =>
      store.login({ ...(latest.current.receiver ? { receiver: latest.current.receiver } : {}), ...overrides }),
    [store],
  )
  const logout = useCallback((logoutOptions?: { revoke?: boolean }) => store.logout(logoutOptions), [store])
  const refresh = useCallback(() => store.refresh(), [store])
  const getAccessToken = useCallback(() => store.getAccessToken(), [store])
  const cancel = useCallback(() => store.cancel(), [store])

  return { ...state, client: store.client, flow, login, logout, refresh, getAccessToken, cancel }
}
