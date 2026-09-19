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
 * `WorkerGlobalScope` is not the marker that separates them, however tempting
 * it reads. Cloudflare's workerd defines it as a global constructor while
 * being exactly the server case this guards — one process answering every
 * request — so testing for it hands server-side rendering on that runtime a
 * module-scoped `Map` and pools every user's tokens into it, which is the one
 * outcome {@link unavailableStorage} exists to refuse. `WorkerNavigator` is
 * `[Exposed=Worker]`, so every real worker scope has it and a document never
 * does; workerd exposes neither it nor `WorkerLocation`. Tested by name rather
 * than by `instanceof`, since a reference to a missing global would throw a
 * `ReferenceError` into the adapters' `catch` and degrade to memory there —
 * the very thing being avoided.
 */
function inWebWorker(): boolean {
  return 'WorkerNavigator' in globalThis
}

/**
 * One {@link AuthStorage} per backing web storage object.
 *
 * `fromSyncStorage` mints a fresh object literal on every call, and the
 * registry's serialisation of `consume()` hangs off the store *object* — so
 * without this, the shape the browser actually has defeats it. `loginWithPopup`
 * builds a client per call and `createBrowserAuthClient` defaults each one to
 * `sessionStorageAdapter()`, so two concurrent logins over the one page's
 * `sessionStorage` used to key two different in-flight maps and serialise
 * nothing: both read the same pending record, both posted the same code with
 * the same verifier, and RFC 6749 §4.1.2 lets the authorization server revoke
 * everything it issued for a code it sees twice. Handing back the same adapter
 * for the same `sessionStorage` is what makes the lock bite.
 *
 * Only the web-storage path is pooled, and deliberately. The
 * {@link memoryStorage} fallback is *not* memoised: it stands in for storage
 * that is unavailable right now, where sharing one `Map` between callers would
 * pool tokens across contexts that the browser is keeping apart. Nor does this
 * cache anything about availability — `typeof`, the worker branch and the
 * write probe all still run on every call, so a store that starts throwing
 * mid-session still degrades to memory exactly as before.
 */
const adapters = new WeakMap<Storage, AuthStorage>()

function adapterFor(storage: Storage): AuthStorage {
  const existing = adapters.get(storage)

  if (existing) {
    return existing
  }

  const created = fromSyncStorage(storage)
  adapters.set(storage, created)

  return created
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
 *
 * Repeated calls in one context hand back the same adapter object (see
 * {@link adapterFor}), which is what lets clients built separately serialise
 * against each other.
 */
export function localStorageAdapter(): AuthStorage {
  try {
    if (typeof localStorage === 'undefined') {
      return inWebWorker() ? memoryStorage() : unavailableStorage('localStorageAdapter')
    }

    const probe = '__aioauth_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)

    return adapterFor(localStorage)
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
 * exist" are handled differently rather than both quietly falling back, and
 * {@link adapterFor} for why every call in one context returns the same object.
 */
export function sessionStorageAdapter(): AuthStorage {
  try {
    if (typeof sessionStorage === 'undefined') {
      return inWebWorker() ? memoryStorage() : unavailableStorage('sessionStorageAdapter')
    }

    const probe = '__aioauth_probe__'
    sessionStorage.setItem(probe, '1')
    sessionStorage.removeItem(probe)

    return adapterFor(sessionStorage)
  } catch {
    /* fall through to memory */
  }

  return memoryStorage()
}
