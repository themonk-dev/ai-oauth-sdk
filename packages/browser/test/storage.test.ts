// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthorizationRegistry } from '@ai-oauth-sdk/core'

import { localStorageAdapter, sessionStorageAdapter } from '../src/storage.js'

/**
 * Whether this environment actually provides web storage.
 *
 * A real browser always does. A jsdom-backed test environment usually does, but
 * not always — vitest's jsdom environment does not install `localStorage` on
 * Node 26, even though jsdom itself supports it there. That is exactly the
 * condition the adapters are built to survive, so the round-trip tests skip and
 * the fallback tests below carry the load.
 */
const hasWebStorage = typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined'

beforeEach(() => {
  if (hasWebStorage) {
    localStorage.clear()
    sessionStorage.clear()
  }

  vi.restoreAllMocks()
})

describe.skipIf(!hasWebStorage)('with web storage available', () => {
  it('localStorageAdapter round-trips values', async () => {
    const storage = localStorageAdapter()
    expect(await storage.get('missing')).toBeNull()

    await storage.set('k', 'v')
    expect(await storage.get('k')).toBe('v')
    expect(localStorage.getItem('k')).toBe('v')

    await storage.delete('k')
    expect(await storage.get('k')).toBeNull()
  })

  it('sessionStorageAdapter writes to sessionStorage, not localStorage', async () => {
    const storage = sessionStorageAdapter()
    await storage.set('k', 'v')

    // The default for browsers: survives the redirect round-trip, not the tab.
    expect(sessionStorage.getItem('k')).toBe('v')
    expect(localStorage.getItem('k')).toBeNull()
  })

  it('keeps the two stores independent', async () => {
    await localStorageAdapter().set('k', 'local')
    await sessionStorageAdapter().set('k', 'session')

    expect(await localStorageAdapter().get('k')).toBe('local')
    expect(await sessionStorageAdapter().get('k')).toBe('session')
  })

  it('exposes keys(), so abandoned logins can be swept', async () => {
    // Without this, `AuthorizationRegistry.prune()` is a silent no-op in the
    // browser and every abandoned login strands a PKCE verifier permanently.
    const storage = localStorageAdapter()
    expect(storage.keys).toBeTypeOf('function')

    await storage.set('pending:one', '{}')
    await storage.set('tokens:openai', '{}')
    expect((await storage.keys!()).sort()).toEqual(['pending:one', 'tokens:openai'])

    await storage.delete('pending:one')
    expect(await storage.keys!()).toEqual(['tokens:openai'])
  })

  it('sessionStorageAdapter exposes keys() too', async () => {
    const storage = sessionStorageAdapter()
    await storage.set('pending:one', '{}')
    expect(await storage.keys?.()).toEqual(['pending:one'])
  })

  it('prune() actually removes expired records from web storage', async () => {
    const storage = sessionStorageAdapter()
    const registry = new AuthorizationRegistry({ storage, ttlMs: 1 })

    for (let i = 0; i < 3; i++) {
      await registry.create({
        state: `s${i}`,
        provider: 'demo',
        redirectUri: 'https://app.test/cb',
        codeVerifier: `verifier-${i}`,
      })
    }

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await registry.prune()).toBe(3)
    expect(await storage.keys?.()).toEqual([])
  })

  it('falls back to memory when storage throws', async () => {
    // Safari private mode and cross-origin iframes throw on access rather than
    // returning null; sign-in should degrade, not crash.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })

    const storage = localStorageAdapter()
    await expect(storage.set('k', 'v')).resolves.toBeUndefined()
    expect(await storage.get('k')).toBe('v')
  })
})

describe('without web storage', () => {
  /**
   * Removes the global entirely. This is the condition the adapters actually
   * branch on (`typeof localStorage === 'undefined'`), so it stands in for
   * both an embedder that never installed the global and, more importantly,
   * server-side rendering, where the same `typeof` check comes back
   * `'undefined'` for the same reason: there is no browser here.
   */
  function hide(name: 'localStorage' | 'sessionStorage') {
    return define(name, undefined)
  }

  /**
   * Installs a global, restoring whatever was there when the returned function
   * is called. `location` and `navigator` already exist under jsdom, so the
   * worker-shaped and workerd-shaped scopes below have to replace them rather
   * than merely define them.
   *
   * `undefined` removes the property outright rather than setting it to
   * `undefined`, because the two are not the same global: `'x' in globalThis`
   * is still true for a property that exists and holds `undefined`, and a
   * runtime that does not implement `x` at all is what these fakes model.
   */
  function define(name: string, value: unknown) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)

    if (value === undefined) {
      Reflect.deleteProperty(globalThis, name)
    } else {
      Object.defineProperty(globalThis, name, { value, configurable: true })
    }

    return () => {
      if (original) {
        Object.defineProperty(globalThis, name, original)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    }
  }

  /**
   * Applies several globals at once and hands back a single undo, so a test
   * that models a whole scope reads as one setup line and one teardown line.
   */
  function defineAll(globals: Record<string, unknown>) {
    const undos = Object.entries(globals).map(([name, value]) => define(name, value))

    return () => {
      for (const undo of undos.reverse()) {
        undo()
      }
    }
  }

  /**
   * Stands in for a real browser Web Worker scope: no web storage and no
   * `window`, exactly as on a server, and separated from one by the things the
   * HTML spec requires of a worker global — `globalThis` really being a
   * `WorkerGlobalScope`, `WorkerNavigator` exposed, and a `location`.
   *
   * `globalThis` cannot be reparented onto a fake prototype under jsdom without
   * breaking the environment, so `Symbol.hasInstance` reproduces the one thing
   * that reparenting would be for: `globalThis instanceof WorkerGlobalScope` is
   * true, and true of nothing else. Measured against Chromium, where that holds
   * in both a dedicated worker and a service worker.
   */
  function pretendWorker() {
    class FakeWorkerGlobalScope {
      static [Symbol.hasInstance](value: unknown) {
        return value === globalThis
      }
    }

    return defineAll({
      WorkerGlobalScope: FakeWorkerGlobalScope,
      WorkerNavigator: class WorkerNavigator {},
      location: { href: 'https://app.test/worker.js' },
      navigator: { userAgent: 'Mozilla/5.0 (worker)' },
    })
  }

  /**
   * Stands in for a workerd isolate — Cloudflare Workers and Pages Functions,
   * `@cloudflare/next-on-pages`, `adapter-cloudflare`, Nitro's
   * `cloudflare_module` — which is a *server*, whatever its global is called.
   *
   * Every value here was measured in the real `workerd` binary:
   * `WorkerGlobalScope` is exposed but `globalThis` is not an instance of it,
   * the global's own constructor is named `ServiceWorkerGlobalScope`, there is
   * no `WorkerNavigator` and no `location`, and the user agent is
   * `Cloudflare-Workers`.
   */
  function pretendWorkerd() {
    return defineAll({
      WorkerGlobalScope: class WorkerGlobalScope {},
      WorkerNavigator: undefined,
      location: undefined,
      navigator: { userAgent: 'Cloudflare-Workers' },
    })
  }

  it('localStorageAdapter does not throw on construction', () => {
    // Hooks and factories call this directly from a render body
    // (`useAuth({ storage: localStorageAdapter() })`), and SSR runs that body
    // too. Merely constructing the adapter must never take down a server
    // render that never goes on to use it.
    const restore = hide('localStorage')

    try {
      expect(() => localStorageAdapter()).not.toThrow()
    } finally {
      restore()
    }
  })

  it('sessionStorageAdapter does not throw on construction', () => {
    const restore = hide('sessionStorage')

    try {
      expect(() => sessionStorageAdapter()).not.toThrow()
    } finally {
      restore()
    }
  })

  it('localStorageAdapter refuses every operation, naming the shared-store risk', async () => {
    const restore = hide('localStorage')

    try {
      const storage = localStorageAdapter()

      await expect(storage.get('k')).rejects.toThrow(/shared/i)
      await expect(storage.set('k', 'v')).rejects.toThrow(/shared/i)
      await expect(storage.delete('k')).rejects.toThrow(/shared/i)
      await expect(storage.keys?.()).rejects.toThrow(/shared/i)
    } finally {
      restore()
    }
  })

  it('sessionStorageAdapter refuses every operation too', async () => {
    const restore = hide('sessionStorage')

    try {
      const storage = sessionStorageAdapter()

      await expect(storage.get('k')).rejects.toThrow(/shared/i)
      await expect(storage.set('k', 'v')).rejects.toThrow(/shared/i)
      await expect(storage.delete('k')).rejects.toThrow(/shared/i)
      await expect(storage.keys?.()).rejects.toThrow(/shared/i)
    } finally {
      restore()
    }
  })

  it('refuses with a code, like every other failure the SDK raises', async () => {
    // A caller branching on `error.code` should not have to string-match this
    // one refusal out of all of them.
    const restore = hide('localStorage')

    try {
      await expect(localStorageAdapter().get('k')).rejects.toMatchObject({
        code: 'unsupported_runtime',
      })
    } finally {
      restore()
    }
  })

  it('degrades to memory in a Web Worker, which is one browser and one user', async () => {
    // A worker reaches the same branch SSR does — no web storage, no window —
    // but nothing there is shared between users, so refusing would break a
    // sign-in driven from a worker for nothing.
    const restoreLocal = hide('localStorage')
    const restoreSession = hide('sessionStorage')
    const restoreWorker = pretendWorker()

    try {
      const local = localStorageAdapter()
      const session = sessionStorageAdapter()

      await local.set('k', 'local')
      await session.set('k', 'session')

      expect(await local.get('k')).toBe('local')
      expect(await session.get('k')).toBe('session')
    } finally {
      restoreWorker()
      restoreSession()
      restoreLocal()
    }
  })

  it('refuses on workerd, which exposes WorkerGlobalScope but is a server', async () => {
    // Cloudflare Workers and everything else on workerd answer yes to
    // `'WorkerGlobalScope' in globalThis`, and are a server: one isolate
    // serves every request, so an in-memory store there is one Map holding
    // every user's tokens. Reproduced in the real binary — three requests on
    // three connections, and requests two and three read request one's access
    // token straight out of the shared store.
    const restoreLocal = hide('localStorage')
    const restoreSession = hide('sessionStorage')
    const restoreWorkerd = pretendWorkerd()

    try {
      await expect(localStorageAdapter().set('k', 'v')).rejects.toThrow(/shared/i)
      await expect(sessionStorageAdapter().set('k', 'v')).rejects.toThrow(/shared/i)
      await expect(localStorageAdapter().get('k')).rejects.toMatchObject({
        code: 'unsupported_runtime',
      })
    } finally {
      restoreWorkerd()
      restoreSession()
      restoreLocal()
    }
  })

  it('refuses a workerd-alike that does not name itself Cloudflare', async () => {
    // The user agent is a legible deny for the host we know about, not the
    // test. Any other embedder of workerd — or a future release of it — is
    // free to report something else, and must still be refused.
    const restoreLocal = hide('localStorage')
    const restoreSession = hide('sessionStorage')
    const restoreWorkerd = pretendWorkerd()
    const restoreAgent = define('navigator', { userAgent: 'SomeEdgeRuntime/1.0' })

    try {
      await expect(localStorageAdapter().set('k', 'v')).rejects.toThrow(/shared/i)
      await expect(sessionStorageAdapter().set('k', 'v')).rejects.toThrow(/shared/i)
    } finally {
      restoreAgent()
      restoreWorkerd()
      restoreSession()
      restoreLocal()
    }
  })

  it('refuses a scope that is a WorkerGlobalScope but has no worker API surface', async () => {
    // `globalThis instanceof WorkerGlobalScope` is false on workerd today only
    // because of how workerd wires that binding up, which it never promised
    // and could change. If it ever becomes true, the spec-mandated members it
    // does not implement — `WorkerNavigator`, `location` — still have to keep
    // the refusal, so this pins the case where instanceof alone would pass.
    const restoreLocal = hide('localStorage')
    const restoreSession = hide('sessionStorage')
    const restoreWorkerd = pretendWorkerd()
    const restoreScope = defineAll({
      WorkerGlobalScope: class WorkerGlobalScope {
        static [Symbol.hasInstance](value: unknown) {
          return value === globalThis
        }
      },
      navigator: { userAgent: 'SomeEdgeRuntime/1.0' },
    })

    try {
      await expect(localStorageAdapter().set('k', 'v')).rejects.toThrow(/shared/i)
      await expect(sessionStorageAdapter().set('k', 'v')).rejects.toThrow(/shared/i)
    } finally {
      restoreScope()
      restoreWorkerd()
      restoreSession()
      restoreLocal()
    }
  })

  it('refuses an unrecognised runtime rather than guessing it is a worker', async () => {
    // Fail closed. A developer genuinely inside an exotic worker can pass
    // `storage:` explicitly and the refusal says so; a developer whose
    // deployment silently pools its users' tokens has no way to find out.
    const restoreLocal = hide('localStorage')
    const restoreSession = hide('sessionStorage')
    const restoreScope = defineAll({
      WorkerGlobalScope: class WorkerGlobalScope {},
      WorkerNavigator: class WorkerNavigator {},
      location: undefined,
      navigator: undefined,
    })

    try {
      await expect(localStorageAdapter().get('k')).rejects.toThrow(/shared/i)
      await expect(sessionStorageAdapter().get('k')).rejects.toThrow(/shared/i)
    } finally {
      restoreScope()
      restoreSession()
      restoreLocal()
    }
  })
})
