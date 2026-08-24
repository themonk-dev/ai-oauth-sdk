import { OAuthError, fromSyncStorage, memoryStorage, type AuthStorage } from '@ai-oauth-sdk/core'

/**
 * Whether this is a Web Worker rather than a server.
 *
 * A worker has no web storage and no `window`, so it lands in the same branch
 * server-side rendering does, and the two want opposite answers. A worker is
 * still one user's browser: an in-memory store there is scoped to that one
 * context, exactly as the Safari-private-mode fallback is, and refusing would
 * break a sign-in driven from a worker for no gain.
 *
 * `WorkerGlobalScope` alone does not separate the two, though it reads as if it
 * should. Cloudflare's workerd declares it as a global class and puts it on the
 * Worker global object too, so `'WorkerGlobalScope' in globalThis` is true
 * there — and workerd is a server, multiplexing every request in a deployment
 * through one isolate whose module scope outlives them all. Workers is a
 * runtime this package documents as supported, so that probe handed back
 * `memoryStorage()` for precisely the case {@link unavailableStorage} exists to
 * refuse: one `Map`, every user's tokens. `globalThis instanceof
 * WorkerGlobalScope` does not help either, since workerd's global really is
 * one.
 *
 * So the test is positive evidence of a *browser* worker rather than absence of
 * a server. `WorkerNavigator` is `[Exposed=Worker]`, so every real worker scope
 * has it; workerd has no such global, and neither do Node, Deno or Bun. Both
 * signals are required.
 *
 * A browser that somehow offered `WorkerGlobalScope` without `WorkerNavigator`
 * would get the refusal rather than a silent in-memory store — a failed
 * sign-in with a message naming the reason, which is the direction this
 * decision should fail in.
 */
function inWebWorker(): boolean {
  const scope = globalThis as { WorkerGlobalScope?: unknown; WorkerNavigator?: unknown }

  return typeof scope.WorkerGlobalScope === 'function' && typeof scope.WorkerNavigator === 'function'
}

/**
 * Stands in when there is no browser storage global at all — not "unavailable
 * right now" (Safari private mode, a sandboxed iframe: both *throw* on access,
 * and are handled below by degrading to memory) but "absent because this
 * isn't a browser." This package is imported from `"use client"` files, and
 * frameworks routinely evaluate those during server-side rendering, where
 * `localStorage`/`sessionStorage` simply don't exist — no exception, `typeof`
 * just comes back `'undefined'`.
 *
 * Construction has to stay inert: `createBrowserAuthClient()` and hooks like
 * `useAuth({ storage: sessionStorageAdapter() })` call these adapters directly
 * from a component's render body, which SSR runs too, well before any effect
 * decides whether the result is ever used. Throwing here would take down a
 * server render for an app that merely imported the SDK.
 *
 * Use is a different matter. Silently returning `memoryStorage()` for this
 * case — as opposed to the genuine "throws on access" case above — used to be
 * exactly the bug: on the server, `memoryStorage()` is a plain `Map` scoped to
 * the module, not the request, so every operation here instead rejects with a
 * message naming that risk, the moment something actually tries to read or
 * write through it.
 */
function unavailableStorage(adapterName: string): AuthStorage {
  const refuse = (): Promise<never> =>
    Promise.reject(
      new OAuthError(
        'unsupported_runtime',
        `${adapterName}() has no browser storage to use here — no web storage global exists and ` +
          'this is not a Web Worker either, which usually means this ran during server-side ' +
          "rendering. Silently handing back an in-memory store would pool every user's tokens " +
          'into one Map shared by every request in the server process. If an in-memory store is ' +
          'genuinely what you want on the server, ask for it explicitly: memoryStorage() from ' +
          '"@ai-oauth-sdk/core".',
      ),
    )

  return { get: refuse, set: refuse, delete: refuse, keys: refuse }
}

/**
 * `localStorage`-backed storage.
 *
 * Falls back to in-memory when storage exists but throws on access — Safari
 * private mode and cross-origin iframes do this rather than returning null,
 * and a login flow should degrade to session-scoped rather than crash. When
 * `localStorage` doesn't exist at all, that's a different case (see
 * {@link unavailableStorage}) and is not treated as "degrade quietly," unless
 * this is a Web Worker (see {@link inWebWorker}).
 */
export function localStorageAdapter(): AuthStorage {
  try {
    if (typeof localStorage === 'undefined') {
      return inWebWorker() ? memoryStorage() : unavailableStorage('localStorageAdapter')
    }

    const probe = '__aioauth_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)

    return fromSyncStorage(localStorage)
  } catch {
    /* fall through to memory */
  }

  return memoryStorage()
}

/**
 * `sessionStorage`-backed storage.
 *
 * The better default for the redirect flow: the PKCE verifier must survive the
 * page navigation, but should not outlive the tab. See
 * {@link localStorageAdapter} for why "storage throws" and "storage doesn't
 * exist" are handled differently rather than both quietly falling back.
 */
export function sessionStorageAdapter(): AuthStorage {
  try {
    if (typeof sessionStorage === 'undefined') {
      return inWebWorker() ? memoryStorage() : unavailableStorage('sessionStorageAdapter')
    }

    const probe = '__aioauth_probe__'
    sessionStorage.setItem(probe, '1')
    sessionStorage.removeItem(probe)

    return fromSyncStorage(sessionStorage)
  } catch {
    /* fall through to memory */
  }

  return memoryStorage()
}
