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
  /**
   * Identity for the adapters this hook cannot look inside — `storage`,
   * `crypto`, `fetch`.
   *
   * They are captured once, when the client is built, and never re-read: the
   * client holds `storage` in a `readonly` field and hands the same instance
   * to its authorization registry. So a `storage` that has come to *mean*
   * something different — the store belonging to a different signed-in user —
   * cannot announce itself by changing object identity. Nothing in the key
   * below would move, the previous user's client would stay, and their tokens
   * would keep being served.
   *
   * The adapters are deliberately not keyed on directly. Built inline in a
   * component body — which is how this repo's own examples write them — their
   * identity changes on every render, and keying on that would rebuild the
   * client mid-flow and cancel in-flight logins: strictly worse than the gap
   * it closed. A string the caller controls is stable by construction.
   *
   * Pass it whenever a `storage` adapter is scoped per user, and keep it
   * stable per identity: `storageKey={appUserId}`, never a fresh value each
   * render.
   */
  storageKey?: string
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
 * The store's identity is every option that is plain data and safe to hold in a
 * memo dependency: the provider, client id, redirect URI, scopes, account key,
 * extra auth params, the TTL and skew numbers, and
 * {@link UseAuthOptions.storageKey}. Rebuilding it every
 * render would drop in-flight flows and the token cache, so all of these are
 * compared by *value* — an inline `extraAuthParams={{ prompt: 'consent' }}`
 * hashes equal across renders and does not churn the client.
 *
 * The adapters — `storage`, `crypto`, `fetch` — are deliberately absent, for
 * the reason given on `storageKey`: keying on an object identity that changes
 * every render would cancel the very logins this hook exists to run. That is
 * what `storageKey` is for, and why swapping `storage` alone is not enough to
 * re-key a client.
 *
 * `clientSecret` is absent too, for a different reason: a `useMemo` dependency
 * is visible in React DevTools, and a client secret does not belong there.
 * Change it together with `storageKey` if it ever has to move at runtime.
 *
 * Callbacks are read through a ref so they stay current without joining that
 * identity. `subscribe` emits immediately, so the mount effect also resyncs
 * state after a remount.
 */
export function useAuth(options: UseAuthOptions): UseAuthResult {
  const {
    receiver,
    restoreOnMount = true,
    onSuccess,
    onError,
    origin,
    storageKey,
    ...clientOptions
  } = options

  const clientKey = JSON.stringify({
    provider:
      typeof clientOptions.provider === 'string' ? clientOptions.provider : clientOptions.provider.id,
    clientId: clientOptions.clientId,
    redirectUri: clientOptions.redirectUri,
    scopes: clientOptions.scopes,
    accountKey: clientOptions.accountKey,
    extraAuthParams: clientOptions.extraAuthParams,
    stateTtlMs: clientOptions.stateTtlMs,
    expirySkewMs: clientOptions.expirySkewMs,
    storageKey,
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

  /* A new store must not be read through the old store's state, even once.
     `useState`'s initializer runs on mount only, so on the render where
     `clientKey` moved, `store` is already the new one while `state` still holds
     what the old one last published — and the new store's `subscribe` does not
     emit until the effect below runs, after this render has committed. That
     committed render is the whole bug this hook is being fixed for, in
     miniature: a `storageKey` swap would paint the previous user's tokens,
     refresh token included, under the client that replaced them. Resetting
     during render rather than in an effect is what keeps it off the screen. */
  const storeRef = useRef(store)

  if (storeRef.current !== store) {
    storeRef.current = store
    setState(store.getState())
  }

  /* The one case `storageKey` cannot fix on its own: an app that never learns
     it exists. A `storage` swapped while a session is held is the dangerous
     shape — the client keeps the old store, so the previous user's tokens go
     on being served, and nothing else in the hook says so.

     Silent whenever `clientKey` moved on the same render, which is the test
     that matters rather than `storageKey` alone: an app re-keying through
     `accountKey` has already done the right thing, and telling it otherwise
     would be a warning for correct code. Gated on `state.tokens` because a swap
     with no session held is benign, and latched because the inline
     `storage: memoryStorage()` idiom is a fresh object every render — warning
     on each would bury the signal in the noise it exists to cut through.

     Dev only, and deliberately inert where `NODE_ENV` is absent entirely: a
     bundler substitutes the literal `process.env.NODE_ENV`, not this
     `globalThis` read, so treating "undefined" as development would ship the
     warning to production. This package is browser-facing and carries no Node
     types, which is why the global cannot be read directly. */
  const warnedRef = useRef(false)
  const storageRef = useRef(clientOptions.storage)
  const clientKeyRef = useRef(clientKey)
  const reKeyed = clientKeyRef.current !== clientKey

  clientKeyRef.current = clientKey

  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['NODE_ENV']

  if (
    nodeEnv !== undefined &&
    nodeEnv !== 'production' &&
    !warnedRef.current &&
    !reKeyed &&
    storageKey === undefined &&
    clientOptions.storage !== storageRef.current &&
    state.tokens !== undefined
  ) {
    warnedRef.current = true
    console.warn(
      '[ai-oauth-sdk] `storage` changed while a session was held, but the client was built ' +
        'with the previous adapter and will keep reading it — tokens included. If the new ' +
        'store belongs to a different user, pass a `storageKey` that changes with them. If it ' +
        'is the same store rebuilt each render, hoist it out of the component.',
    )
  }

  storageRef.current = clientOptions.storage

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
