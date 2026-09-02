/**
 * Regressions for the token cache: the read that overwrote newer state, and the
 * write that committed to memory before it was persisted.
 *
 * Both need a storage backend that is slow or that fails — a keychain prompt, a
 * full disk — so every test here drives one deliberately.
 */
import { describe, expect, it, vi } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { defineProvider } from '../src/providers/define.js'
import type { AuthStorage, TokenSet } from '../src/types.js'

const provider = defineProvider({
  id: 'demo',
  label: 'Demo',
  clientId: 'demo-client',
  authorizationUrl: 'https://provider.invalid/authorize',
  tokenUrl: 'https://provider.invalid/token',
  scopes: [],
  redirect: { mode: 'custom' },
})

const tokenSet = (accessToken: string, refreshToken?: string): TokenSet => ({
  accessToken,
  ...(refreshToken ? { refreshToken } : {}),
  tokenType: 'Bearer',
  provider: 'demo',
  raw: {},
})

interface GatedStorage {
  storage: AuthStorage
  map: Map<string, string>
  /** Resolves once the first `get` has snapshotted its value and blocked. */
  reading: Promise<void>
  /** Lets the blocked `get` return the value it read on the way in. */
  release: () => void
  gets: number
}

/**
 * Storage whose first `get` reads the value, then blocks until released.
 *
 * The snapshot matters: a SecureStore read that starts before a login and
 * returns after it hands back what was there when it started, not what is there
 * now — which is exactly what makes the stale write-back possible.
 */
function gatedStorage(initial?: Record<string, string>): GatedStorage {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  let openGate!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  let gated = true
  const state = {
    map,
    reading,
    release: openGate,
    gets: 0,
    storage: {
      async get(key: string) {
        state.gets++
        const value = map.get(key) ?? null

        if (gated) {
          gated = false
          started()
          await gate
        }

        return value
      },
      async set(key: string, value: string) {
        map.set(key, value)
      },
      async delete(key: string) {
        map.delete(key)
      },
    } satisfies AuthStorage,
  }

  return state
}

describe('getTokens() against a slow storage read', () => {
  it('keeps a login that landed while the read was in flight', async () => {
    const gated = gatedStorage()
    const client = createAuthClient({ provider, storage: gated.storage })

    // Cold client, empty storage, and the read blocks on the keychain prompt.
    const pending = client.getTokens()
    await gated.reading

    // The user finishes logging in while that prompt is still up.
    await client.setTokens(tokenSet('AT'))

    gated.release()

    // The read is older than the login, so its (empty) result must be dropped.
    expect(await pending).toMatchObject({ accessToken: 'AT' })
    expect(await client.getTokens()).toMatchObject({ accessToken: 'AT' })
    // The real symptom: "Not authenticated" for the life of the process, while
    // the token sits in storage.
    await expect(client.getAccessToken()).resolves.toBe('AT')
  })

  it('does not sign the user back in after a logout that landed mid-read', async () => {
    const gated = gatedStorage({ 'tokens:demo': JSON.stringify(tokenSet('AT')) })
    const client = createAuthClient({ provider, storage: gated.storage })

    const pending = client.getTokens()
    await gated.reading

    await client.logout()

    gated.release()

    expect(await pending).toBeUndefined()
    expect(await client.getTokens()).toBeUndefined()
    expect(await client.isAuthenticated()).toBe(false)
  })

  it('shares one read across concurrent callers', async () => {
    const gated = gatedStorage({ 'tokens:demo': JSON.stringify(tokenSet('AT')) })
    const client = createAuthClient({ provider, storage: gated.storage })

    // Ten parallel API calls on a cold client must not be ten keychain prompts.
    const all = Promise.all(Array.from({ length: 10 }, () => client.getTokens()))
    await gated.reading
    gated.release()

    for (const tokens of await all) {
      expect(tokens).toMatchObject({ accessToken: 'AT' })
    }

    expect(gated.gets).toBe(1)
  })
})

describe('setTokens() when the write fails', () => {
  const failingStorage = (map: Map<string, string>): AuthStorage => ({
    async get(key) {
      return map.get(key) ?? null
    },
    async set() {
      throw new Error('quota exceeded')
    },
    async delete(key) {
      map.delete(key)
    },
  })

  it('leaves the client unauthenticated when nothing was persisted', async () => {
    const client = createAuthClient({ provider, storage: failingStorage(new Map()) })

    await expect(client.setTokens(tokenSet('AT'))).rejects.toThrow('quota exceeded')

    // The caller saw a failure; the client must not claim to be signed in.
    expect(await client.getTokens()).toBeUndefined()
    expect(await client.isAuthenticated()).toBe(false)
  })

  it('keeps the persisted tokens when a rotation cannot be written', async () => {
    const map = new Map([['tokens:demo', JSON.stringify(tokenSet('AT', 'RT'))]])
    const client = createAuthClient({ provider, storage: failingStorage(map) })

    expect(await client.getTokens()).toMatchObject({ accessToken: 'AT' })

    // A rotating provider just handed us RT2 and retired RT. If the write fails
    // and we keep RT2 in memory only, it dies with the process and the spent RT
    // on disk is all that is left.
    await expect(client.setTokens(tokenSet('AT2', 'RT2'))).rejects.toThrow('quota exceeded')

    expect(await client.getTokens()).toMatchObject({ accessToken: 'AT', refreshToken: 'RT' })
    expect(map.get('tokens:demo')).toContain('RT')
  })
})

/**
 * The write side needs the same protection the read side got. Persisting before
 * committing put `setTokens`' commit behind an await, so which value wins the
 * cache stopped being decided by call order.
 */
describe('a write that finishes after something newer', () => {
  /** A storage whose `set` for a given key blocks until it is released. */
  function gatedWrites(map: Map<string, string>) {
    const gates: Array<() => void> = []

    return {
      gates,
      storage: {
        get: async (key: string) => map.get(key) ?? null,
        set: async (key: string, value: string) => {
          await new Promise<void>((resolve) => gates.push(resolve))
          map.set(key, value)
        },
        delete: async (key: string) => {
          map.delete(key)
        },
      } satisfies AuthStorage,
    }
  }

  it('does not undo a logout that completed while the write was in flight', async () => {
    const map = new Map<string, string>()
    const { gates, storage } = gatedWrites(map)
    const client = createAuthClient({ provider, storage })

    const writing = client.setTokens(tokenSet('AT'))
    await vi.waitFor(() => expect(gates).toHaveLength(1))

    // A background refresh is mid-write when the user signs out.
    await client.logout()
    gates[0]?.()
    await writing

    // The sign-out is the newer intent; the write must not resurrect the session.
    expect(await client.getTokens()).toBeUndefined()
    expect(await client.isAuthenticated()).toBe(false)
  })

  it('does not leave the cache holding the older of two overlapping writes', async () => {
    const map = new Map<string, string>()
    const { gates, storage } = gatedWrites(map)
    const client = createAuthClient({ provider, storage })

    const slow = client.setTokens(tokenSet('AT1'))
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    const fast = client.setTokens(tokenSet('AT2'))
    await vi.waitFor(() => expect(gates).toHaveLength(2))

    // The second call wins the cache; the first must not overwrite it on the
    // way out just because its write finished last.
    gates[1]?.()
    await fast
    gates[0]?.()
    await slow

    expect(await client.getTokens()).toMatchObject({ accessToken: 'AT2' })
  })
})

/**
 * `logout()` promises local state goes regardless of what revocation or storage
 * did. A store that cannot be read must not break that promise.
 */
describe('logout against an unreadable store', () => {
  it('still clears local state when the credential cannot be read', async () => {
    const map = new Map([['tokens:demo', JSON.stringify(tokenSet('AT', 'RT'))]])
    const revocable = defineProvider({
      id: 'demo',
      label: 'Demo',
      clientId: 'demo-client',
      authorizationUrl: 'https://provider.invalid/authorize',
      tokenUrl: 'https://provider.invalid/token',
      revocationUrl: 'https://provider.invalid/revoke',
      scopes: [],
      redirect: { mode: 'custom' },
    })
    const client = createAuthClient({
      provider: revocable,
      storage: {
        // A locked keychain or an unreadable auth.json.
        get: async (): Promise<string | null> => {
          throw new Error('keychain locked')
        },
        set: async (key: string, value: string) => {
          map.set(key, value)
        },
        delete: async (key: string) => {
          map.delete(key)
        },
      },
    })

    const result = await client.logout({ revoke: true })

    expect(result.signedOut).toBe(true)
    expect(result.revocation).toBe('nothing-to-revoke')
    expect(map.has('tokens:demo')).toBe(false)
  })
})
