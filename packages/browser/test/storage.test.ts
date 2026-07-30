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
  /** Removes the global entirely, as an embedder or locked-down runtime would. */
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

  it('localStorageAdapter still works, backed by memory', async () => {
    const restore = hide('localStorage')
    try {
      const storage = localStorageAdapter()
      await storage.set('k', 'v')
      expect(await storage.get('k')).toBe('v')
      await storage.delete('k')
      expect(await storage.get('k')).toBeNull()
    } finally {
      restore()
    }
  })

  it('sessionStorageAdapter still works, backed by memory', async () => {
    const restore = hide('sessionStorage')
    try {
      const storage = sessionStorageAdapter()
      await storage.set('k', 'v')
      expect(await storage.get('k')).toBe('v')
    } finally {
      restore()
    }
  })

  it('two adapters do not share the memory fallback', async () => {
    const restore = hide('localStorage')
    try {
      // Each call gets its own store, so a page holding two clients does not
      // have one silently overwrite the other's tokens.
      const first = localStorageAdapter()
      const second = localStorageAdapter()
      await first.set('k', 'from-first')
      expect(await second.get('k')).toBeNull()
    } finally {
      restore()
    }
  })
})
