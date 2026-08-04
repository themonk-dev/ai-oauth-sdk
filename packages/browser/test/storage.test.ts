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
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true })

    return () => {
      if (original) {
        Object.defineProperty(globalThis, name, original)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    }
  }

  /**
   * Stands in for a Web Worker scope: no web storage and no `window`, exactly
   * as on a server, and told apart from one only by `WorkerGlobalScope` — which
   * is why the adapters look for that rather than for the storage global.
   */
  function pretendWorker() {
    Object.defineProperty(globalThis, 'WorkerGlobalScope', {
      value: class WorkerGlobalScope {},
      configurable: true,
    })

    return () => Reflect.deleteProperty(globalThis, 'WorkerGlobalScope')
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
})
