import { describe, expect, it } from 'vitest'

import { asyncStorageAdapter, secureStoreAdapter } from '../src/storage.js'

/** Records the keys SecureStore is actually asked for. */
function fakeSecureStore() {
  const map = new Map<string, string>()
  return {
    store: {
      async getItemAsync(key: string) {
        return map.get(key) ?? null
      },
      async setItemAsync(key: string, value: string) {
        map.set(key, value)
      },
      async deleteItemAsync(key: string) {
        map.delete(key)
      },
    },
    keys: () => [...map.keys()],
    map,
  }
}

describe('secureStoreAdapter key encoding', () => {
  it('produces keys SecureStore accepts', async () => {
    const fake = fakeSecureStore()
    const storage = secureStoreAdapter(fake.store)

    await storage.set('tokens:openai:me@corp.com', 'x')

    // SecureStore allows only alphanumerics, `.`, `-` and `_`.
    for (const key of fake.keys()) {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  it('keeps accounts that differ only in disallowed characters apart', async () => {
    const fake = fakeSecureStore()
    const storage = secureStoreAdapter(fake.store)

    // Collapsing every disallowed character onto `_` made these one entry, so
    // two accounts silently overwrote each other's tokens.
    await storage.set('tokens:openai:me@corp.com', 'at-work')
    await storage.set('tokens:openai:me/corp.com', 'at-slash')
    await storage.set('tokens:openai:me_corp.com', 'at-underscore')

    expect(fake.keys()).toHaveLength(3)
    expect(await storage.get('tokens:openai:me@corp.com')).toBe('at-work')
    expect(await storage.get('tokens:openai:me/corp.com')).toBe('at-slash')
    expect(await storage.get('tokens:openai:me_corp.com')).toBe('at-underscore')
  })

  it('round-trips and deletes the key it wrote', async () => {
    const fake = fakeSecureStore()
    const storage = secureStoreAdapter(fake.store)

    await storage.set('tokens:anthropic', 'value')
    expect(await storage.get('tokens:anthropic')).toBe('value')

    await storage.delete('tokens:anthropic')
    expect(await storage.get('tokens:anthropic')).toBeNull()
    expect(fake.keys()).toEqual([])
  })

  it('handles non-ASCII account keys without collapsing them', async () => {
    const fake = fakeSecureStore()
    const storage = secureStoreAdapter(fake.store)

    await storage.set('tokens:openai:café', 'a')
    await storage.set('tokens:openai:cafe', 'b')

    expect(fake.keys()).toHaveLength(2)
    expect(await storage.get('tokens:openai:café')).toBe('a')
  })

  it('forwards the caller options to every call', async () => {
    const seen: unknown[] = []
    const storage = secureStoreAdapter(
      {
        async getItemAsync(_key, options) {
          seen.push(options)
          return null
        },
        async setItemAsync(_key, _value, options) {
          seen.push(options)
        },
        async deleteItemAsync(_key, options) {
          seen.push(options)
        },
      },
      { options: { keychainAccessible: 'WHEN_UNLOCKED' } },
    )

    await storage.set('k', 'v')
    await storage.get('k')
    await storage.delete('k')

    expect(seen).toEqual(Array(3).fill({ keychainAccessible: 'WHEN_UNLOCKED' }))
  })
})

describe('asyncStorageAdapter', () => {
  it('passes keys through unchanged', async () => {
    const map = new Map<string, string>()
    const storage = asyncStorageAdapter({
      async getItem(key) {
        return map.get(key) ?? null
      },
      async setItem(key, value) {
        map.set(key, value)
      },
      async removeItem(key) {
        map.delete(key)
      },
    })

    await storage.set('tokens:openai', 'v')
    // AsyncStorage has no alphabet restriction, so no encoding is needed.
    expect([...map.keys()]).toEqual(['tokens:openai'])
    expect(await storage.get('tokens:openai')).toBe('v')
  })
})
