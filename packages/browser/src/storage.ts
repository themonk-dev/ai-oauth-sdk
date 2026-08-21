import { OAuthError, fromSyncStorage, memoryStorage, type AuthStorage } from '@ai-oauth-sdk/core'

/**
 * Whether this is a browser Web Worker rather than a server.
 *
 * A worker has no web storage and no `window`, so it lands in the same branch
 * server-side rendering does, and the two want opposite answers. A worker is
 * still one user's browser: an in-memory store there is scoped to that one
 * context, exactly as the Safari-private-mode fallback is, and refusing would
 * break a sign-in driven from a worker for no gain.
 *
 * Telling the two apart is genuinely a heuristic, because they do not disagree
 * about anything as convenient as a single global. The obvious test —
 * `'WorkerGlobalScope' in globalThis` — was wrong: workerd exposes a
 * `WorkerGlobalScope` binding too, so Cloudflare Workers and Pages Functions,
 * `@cloudflare/next-on-pages`, `adapter-cloudflare` and Nitro's
 * `cloudflare_module` all answered "worker" and were handed `memoryStorage()`.
 * That `Map` lives at module scope in an isolate that serves many requests, so
 * every user signed into an app deployed there shared one token store — the
 * exact failure {@link unavailableStorage} exists to prevent, in the runtime
 * most likely to hit it. So this asks four questions instead, all of which a
 * real worker answers yes and workerd answers no:
 *
 * 1. `navigator.userAgent` is not `Cloudflare-Workers`. A named deny for the
 *    runtime we know is affected. Cheap and legible, and worth nothing on its
 *    own — every other workerd host is free to report something else, which is
 *    why it is the first conjunct and not the only one.
 * 2. `globalThis instanceof WorkerGlobalScope`. In Chromium this is true in
 *    both a dedicated worker and a service worker, and on workerd it is false,
 *    because the `WorkerGlobalScope` it exposes is not the same function object
 *    as the one in its global's prototype chain. That is an implementation
 *    detail of workerd rather than anything it promises, so it could stop being
 *    true; on its own it would be too load-bearing to rest on.
 * 3. `WorkerNavigator` is exposed. The spec marks it `[Exposed=Worker]`, so
 *    every real worker global has it and workerd does not.
 * 4. `location` is an object. `WorkerGlobalScope.location` is spec-mandated and
 *    not nullable; workerd has no `location` at all.
 *
 * 3 and 4 are the durable pair: they are things the HTML specification requires
 * of a worker global and workerd simply does not implement, rather than quirks.
 * The cost of the conjunction is that a genuine worker in some engine that
 * omits one of them is refused. That is the direction to fail in — the refusal
 * says what to do about it, and a developer who really is in an exotic worker
 * can pass `storage:` explicitly, whereas a developer whose deployment quietly
 * pools its users' tokens has no way to notice.
 */
function inWebWorker(): boolean {
  const scope = globalThis as {
    WorkerGlobalScope?: unknown
    WorkerNavigator?: unknown
    location?: unknown
    navigator?: { userAgent?: unknown }
  }

  if (scope.navigator?.userAgent === 'Cloudflare-Workers') {
    return false
  }

  const WorkerGlobalScopeCtor = scope.WorkerGlobalScope

  if (typeof WorkerGlobalScopeCtor !== 'function') {
    return false
  }

  return (
    scope instanceof WorkerGlobalScopeCtor &&
    'WorkerNavigator' in scope &&
    typeof scope.location === 'object' &&
    scope.location !== null
  )
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
 * write through it. "Server" here includes the worker-shaped ones: an isolate
 * on Cloudflare Workers is no less shared for calling its global a worker (see
 * {@link inWebWorker}).
 */
function unavailableStorage(adapterName: string): AuthStorage {
  const refuse = (): Promise<never> =>
    Promise.reject(
      new OAuthError(
        'unsupported_runtime',
        `${adapterName}() has no browser storage to use here — no web storage global exists and ` +
          'this is not a browser Web Worker either, which usually means server-side rendering, ' +
          'or a server runtime whose global merely looks like a worker (Cloudflare Workers and ' +
          'anything else on workerd). Silently handing back an in-memory store would pool every ' +
          "user's tokens into one Map shared by every request that process or isolate serves. " +
          'If an in-memory store is genuinely what you want on the server, ask for it ' +
          'explicitly: memoryStorage() from "@ai-oauth-sdk/core".',
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
