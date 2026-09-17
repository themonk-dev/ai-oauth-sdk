import { describe, expect, it } from 'vitest'

import { AuthorizationRegistry } from '../src/registry.js'
import { memoryStorage } from '../src/storage.js'

/**
 * A store holding one record this SDK would never have written.
 *
 * Nothing in the library can produce these under a `pending:` key — reaching
 * them needs a foreign writer sharing the store, or a hand-edited credential
 * file. They are here because "parsed successfully" was being read as "is a
 * PendingAuthorization", and the gap between those two is what these cover.
 */
const withPoison = (stored: string, options: { now?: () => number } = {}) => {
  const storage = memoryStorage()
  const registry = new AuthorizationRegistry({ storage, ...options })

  return {
    storage,
    registry,
    seed: async (key = 'pending:poison') => {
      await storage.set(key, stored)

      return key
    },
  }
}

const pendingKeys = async (storage: ReturnType<typeof memoryStorage>) =>
  (await storage.keys!()).filter((key) => key.startsWith('pending:'))

describe('records that parse but are not a pending authorization', () => {
  // `'null'` is valid JSON, so the catch never fired, `record === undefined`
  // was false, and the expiry comparison read a property off null. That
  // TypeError escaped prune() -> create() -> createAuthorization() -> login()
  // before the browser was ever opened, and — thrown before the delete — left
  // the key in place so every later prune() threw again.
  it('prune() drops a stored null instead of throwing on it', async () => {
    const { storage, registry, seed } = withPoison('null')
    await seed()

    await expect(registry.prune()).resolves.toBe(1)
    expect(await storage.get('pending:poison')).toBeNull()
  })

  it.each([
    ['a JSON string', '"just-a-string"'],
    ['a number', '3'],
    ['a boolean', 'true'],
    ['an array', '[]'],
    ['an object with no expiresAt', '{"state":"s1","provider":"p"}'],
    ['an object with a non-numeric expiresAt', '{"state":"s1","provider":"p","expiresAt":"soon"}'],
  ])('prune() sweeps %s rather than leaking it forever', async (_label, stored) => {
    const { storage, registry, seed } = withPoison(stored)
    await seed()

    await expect(registry.prune()).resolves.toBe(1)
    expect(await pendingKeys(storage)).toEqual([])
  })

  it('starting a login survives a poisoned store, and clears it', async () => {
    const { storage, registry, seed } = withPoison('null')
    await seed()

    // create() prunes, so the TypeError surfaced here as a non-OAuthError that
    // `isOAuthError` handling could not recognise.
    await expect(
      registry.create({ state: 's1', provider: 'p', redirectUri: 'http://localhost/cb' }),
    ).resolves.toMatchObject({ state: 's1' })

    expect(await pendingKeys(storage)).toEqual(['pending:s1'])
  })

  it('get() reports a malformed record as absent, like an unparseable one', async () => {
    const { registry, seed } = withPoison('"just-a-string"')
    await seed('pending:s1')

    expect(await registry.get('s1')).toBeUndefined()
  })

  // A scalar was handed straight back as a `PendingAuthorization`, and the
  // expiry check that should have caught it compared against `undefined`.
  it('consume() refuses a scalar record instead of returning it', async () => {
    const { registry, seed } = withPoison('"just-a-string"')
    await seed('pending:s1')

    await expect(registry.consume('s1')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  // The residual TTL hole: an object with the right provider passed the
  // ownership check downstream, and `now > undefined` is false for every clock,
  // so the record was consumed happily at any point in the future.
  it('does not hand back a record whose TTL cannot be evaluated', async () => {
    const { registry, seed } = withPoison(
      '{"state":"s1","provider":"p","redirectUri":"http://localhost/cb","createdAt":0}',
      { now: () => 9_999_999_999_999 },
    )
    await seed('pending:s1')

    await expect(registry.consume('s1')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('consumeLatest() refuses a malformed record too', async () => {
    const { storage, registry, seed } = withPoison('{"state":"s1","provider":"p"}')
    await seed('pending:s1')
    await storage.set('pending-latest:p', 's1')

    await expect(registry.consumeLatest('p')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('still keeps a well-formed record', async () => {
    let now = 1_000_000
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage, ttlMs: 10_000, now: () => now })

    await registry.create({ state: 'good', provider: 'p', redirectUri: 'http://localhost/cb' })
    await storage.set('pending:poison', 'null')

    // Only the poisoned key goes.
    await expect(registry.prune()).resolves.toBe(1)
    await expect(registry.consume('good')).resolves.toMatchObject({ state: 'good' })
  })
})
