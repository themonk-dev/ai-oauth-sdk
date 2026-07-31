import { describe, expect, it, vi } from 'vitest'

import { OAuthError } from '../src/errors.js'
import { AuthorizationRegistry } from '../src/registry.js'
import { memoryStorage } from '../src/storage.js'
import type { TokenSet } from '../src/types.js'

const tokens = (accessToken = 'a'): TokenSet => ({
  accessToken,
  tokenType: 'Bearer',
  provider: 'test',
  raw: {},
})

const make = (options: { ttlMs?: number; now?: () => number } = {}) =>
  new AuthorizationRegistry({ storage: memoryStorage(), ...options })

describe('AuthorizationRegistry', () => {
  it('stores and reads a pending authorization', async () => {
    const registry = make()
    const pending = await registry.create({
      state: 's1',
      provider: 'test',
      redirectUri: 'http://localhost/cb',
      codeVerifier: 'verifier',
    })

    expect(pending.createdAt).toBeLessThanOrEqual(Date.now())
    expect(pending.expiresAt).toBeGreaterThan(Date.now())
    expect(await registry.get('s1')).toMatchObject({ state: 's1', codeVerifier: 'verifier' })
  })

  it('get() does not consume', async () => {
    const registry = make()
    await registry.create({ state: 's1', provider: 'test', redirectUri: 'http://localhost/cb' })

    await registry.get('s1')
    expect(await registry.get('s1')).toBeTruthy()
  })

  it('consume() is single-use', async () => {
    const registry = make()
    await registry.create({ state: 's1', provider: 'test', redirectUri: 'http://localhost/cb' })

    await expect(registry.consume('s1')).resolves.toMatchObject({ state: 's1' })
    // Replaying a state must not replay the exchange.
    await expect(registry.consume('s1')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('rejects an unknown state', async () => {
    await expect(make().consume('nope')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('rejects an expired state, and still consumes it', async () => {
    let now = 1_000_000
    const registry = make({ ttlMs: 100, now: () => now })
    await registry.create({ state: 's1', provider: 'test', redirectUri: 'http://localhost/cb' })

    now += 500
    await expect(registry.consume('s1')).rejects.toMatchObject({ code: 'state_expired' })
    // Expired or not, it is gone — no second attempt.
    await expect(registry.consume('s1')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('survives corrupt stored JSON', async () => {
    const storage = memoryStorage()
    await storage.set('pending:s1', 'not json')
    const registry = new AuthorizationRegistry({ storage })

    expect(await registry.get('s1')).toBeUndefined()
  })

  it('round-trips metadata', async () => {
    const registry = make()
    await registry.create({
      state: 's1',
      provider: 'test',
      redirectUri: 'http://localhost/cb',
      metadata: { userId: 'u1', nested: { a: 1 } },
    })
    expect((await registry.get('s1'))?.metadata).toEqual({ userId: 'u1', nested: { a: 1 } })
  })
})

describe('waitFor', () => {
  it('resolves for a waiter that arrives first', async () => {
    const registry = make()
    const waiting = registry.waitFor('s1')
    registry.resolve('s1', tokens())
    await expect(waiting).resolves.toMatchObject({ accessToken: 'a' })
  })

  it('resolves for a waiter that arrives after the result', async () => {
    const registry = make()
    registry.resolve('s1', tokens())
    // Buffered, so there is no race to lose.
    await expect(registry.waitFor('s1')).resolves.toMatchObject({ accessToken: 'a' })
  })

  it('delivers a buffered result only once', async () => {
    const registry = make()
    registry.resolve('s1', tokens())
    await registry.waitFor('s1')

    const second = await Promise.race([
      registry.waitFor('s1').then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])
    expect(second).toBe('pending')
  })

  it('serves every waiter on one state', async () => {
    const registry = make()
    const waiters = [registry.waitFor('s1'), registry.waitFor('s1'), registry.waitFor('s1')]
    registry.resolve('s1', tokens('shared'))

    for (const result of await Promise.all(waiters)) {
      expect(result.accessToken).toBe('shared')
    }
  })

  it('propagates a rejection to every waiter', async () => {
    const registry = make()
    const waiters = [registry.waitFor('s1'), registry.waitFor('s1')]
    registry.reject('s1', new OAuthError('authorization_denied', 'nope'))

    for (const waiter of waiters) {
      await expect(waiter).rejects.toMatchObject({ code: 'authorization_denied' })
    }
  })

  it('buffers a rejection for a later waiter', async () => {
    const registry = make()
    registry.reject('s1', new OAuthError('authorization_denied', 'nope'))
    await expect(registry.waitFor('s1')).rejects.toMatchObject({ code: 'authorization_denied' })
  })

  it('times out', async () => {
    await expect(make().waitFor('s1', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('aborts on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(make().waitFor('s1', { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    })
  })

  it('aborts on a later signal', async () => {
    const controller = new AbortController()
    const waiting = make().waitFor('s1', { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
  })

  it('does not fire the timeout after resolving', async () => {
    vi.useFakeTimers()

    try {
      const registry = make()
      const waiting = registry.waitFor('s1', { timeoutMs: 50 })
      registry.resolve('s1', tokens())
      await expect(waiting).resolves.toBeTruthy()

      // A stale timer firing here would reject an already-settled promise.
      vi.advanceTimersByTime(200)
      await expect(waiting).resolves.toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps states independent', async () => {
    const registry = make()
    const a = registry.waitFor('s1')
    const b = registry.waitFor('s2')

    registry.resolve('s1', tokens('for-a'))
    await expect(a).resolves.toMatchObject({ accessToken: 'for-a' })

    const bStatus = await Promise.race([
      b.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])
    expect(bStatus).toBe('pending')
  })
})

describe('consumeLatest — for providers that do not echo state', () => {
  it('returns the most recently created flow', async () => {
    const registry = make()
    await registry.create({ state: 'first', provider: 'p', redirectUri: 'http://localhost/cb' })
    await registry.create({ state: 'second', provider: 'p', redirectUri: 'http://localhost/cb' })

    await expect(registry.consumeLatest('p')).resolves.toMatchObject({ state: 'second' })
  })

  it('tracks providers separately', async () => {
    const registry = make()
    await registry.create({ state: 'a1', provider: 'a', redirectUri: 'http://localhost/cb' })
    await registry.create({ state: 'b1', provider: 'b', redirectUri: 'http://localhost/cb' })

    await expect(registry.consumeLatest('a')).resolves.toMatchObject({ state: 'a1' })
    await expect(registry.consumeLatest('b')).resolves.toMatchObject({ state: 'b1' })
  })

  it('throws when nothing is pending', async () => {
    await expect(make().consumeLatest('p')).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('is single-use, like consume()', async () => {
    const registry = make()
    await registry.create({ state: 's1', provider: 'p', redirectUri: 'http://localhost/cb' })

    await registry.consumeLatest('p')
    await expect(registry.consumeLatest('p')).rejects.toMatchObject({ code: 'unknown_state' })
  })
})

describe('abandoned flows are swept from storage', () => {
  it('removes expired pending records when a new flow starts', async () => {
    let now = 1_000_000
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage, ttlMs: 100, now: () => now })

    // Five logins the user starts and walks away from.
    for (let i = 0; i < 5; i++) {
      await registry.create({ state: `abandoned-${i}`, provider: 'p', redirectUri: 'http://x/cb' })
    }

    expect((await storage.keys!()).filter((k) => k.startsWith('pending:'))).toHaveLength(5)

    now += 500
    await registry.create({ state: 'fresh', provider: 'p', redirectUri: 'http://x/cb' })

    const pending = (await storage.keys!()).filter((k) => k.startsWith('pending:'))
    expect(pending).toEqual(['pending:fresh'])
  })

  it('leaves live flows alone', async () => {
    let now = 1_000_000
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage, ttlMs: 10_000, now: () => now })

    await registry.create({ state: 'still-going', provider: 'p', redirectUri: 'http://x/cb' })
    now += 100
    await registry.create({ state: 'also-going', provider: 'p', redirectUri: 'http://x/cb' })

    // Two concurrent logins in different tabs must both survive.
    expect((await storage.keys!()).filter((k) => k.startsWith('pending:'))).toHaveLength(2)
    await expect(registry.consume('still-going')).resolves.toMatchObject({ state: 'still-going' })
  })

  it('drops unparseable records', async () => {
    const storage = memoryStorage()
    await storage.set('pending:corrupt', 'not json')
    const registry = new AuthorizationRegistry({ storage })

    expect(await registry.prune()).toBe(1)
    expect(await storage.get('pending:corrupt')).toBeNull()
  })

  it('reports how many it removed', async () => {
    let now = 1_000_000
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage, ttlMs: 100, now: () => now })

    for (let i = 0; i < 3; i++) {
      await registry.create({ state: `s${i}`, provider: 'p', redirectUri: 'http://x/cb' })
    }

    now += 500
    expect(await registry.prune()).toBe(3)
    expect(await registry.prune()).toBe(0)
  })

  it('is a no-op for storage that cannot enumerate', async () => {
    // SecureStore and friends have no keys(); pruning must not throw.
    const opaque = { ...memoryStorage(), keys: undefined }
    const registry = new AuthorizationRegistry({ storage: opaque })

    await expect(registry.prune()).resolves.toBe(0)
    await expect(
      registry.create({ state: 's1', provider: 'p', redirectUri: 'http://x/cb' }),
    ).resolves.toBeTruthy()
  })
})

describe('buffered results are bounded', () => {
  it('does not grow without limit when nobody ever waits', async () => {
    // The common server shape: completeAuthorization always resolves, and most
    // callers never call waitFor. Unbounded, this leaks one entry per login.
    const registry = new AuthorizationRegistry({
      storage: memoryStorage(),
      maxSettled: 10,
    })

    for (let i = 0; i < 500; i++) {
      registry.resolve(`state-${i}`, tokens())
    }

    expect(registry.bufferedCount).toBeLessThanOrEqual(10)
  })

  it('evicts the oldest first', () => {
    const registry = new AuthorizationRegistry({ storage: memoryStorage(), maxSettled: 3 })

    for (const state of ['a', 'b', 'c', 'd']) {
      registry.resolve(state, tokens(state))
    }

    // 'a' was pushed out; 'd' is the newest and must survive.
    expect(registry.bufferedCount).toBe(3)

    return expect(registry.waitFor('d')).resolves.toMatchObject({ accessToken: 'd' })
  })

  it('expires buffered results on a clock', async () => {
    let now = 1_000_000
    const registry = new AuthorizationRegistry({
      storage: memoryStorage(),
      settledTtlMs: 100,
      now: () => now,
    })

    registry.resolve('s1', tokens())
    expect(registry.bufferedCount).toBe(1)

    now += 500
    // A late waiter must not receive a stale result — it waits instead.
    const status = await Promise.race([
      registry.waitFor('s1').then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])
    expect(status).toBe('pending')
  })

  it('prunes expired entries when new ones arrive', () => {
    let now = 1_000_000
    const registry = new AuthorizationRegistry({
      storage: memoryStorage(),
      settledTtlMs: 100,
      now: () => now,
    })

    for (let i = 0; i < 5; i++) {
      registry.resolve(`old-${i}`, tokens())
    }

    expect(registry.bufferedCount).toBe(5)

    now += 500
    registry.resolve('fresh', tokens())
    // The five stale entries are swept as a side effect of the new insert.
    expect(registry.bufferedCount).toBe(1)
  })

  it('still delivers a result inside its TTL', async () => {
    let now = 1_000_000
    const registry = new AuthorizationRegistry({
      storage: memoryStorage(),
      settledTtlMs: 1000,
      now: () => now,
    })

    registry.resolve('s1', tokens('fresh'))
    now += 500
    await expect(registry.waitFor('s1')).resolves.toMatchObject({ accessToken: 'fresh' })
  })
})

describe('cleanup', () => {
  it('does not retain empty waiter sets after a timeout', async () => {
    const registry = make()

    for (let i = 0; i < 100; i++) {
      await expect(registry.waitFor(`s${i}`, { timeoutMs: 1 })).rejects.toMatchObject({
        code: 'timeout',
      })
    }

    // Nothing buffered, and no per-state residue left behind.
    expect(registry.bufferedCount).toBe(0)
  })

  it('delete() removes a pending record', async () => {
    const registry = make()
    await registry.create({ state: 's1', provider: 'p', redirectUri: 'http://localhost/cb' })
    await registry.delete('s1')
    expect(await registry.get('s1')).toBeUndefined()
  })

  it('clearSettled() drops unclaimed results', async () => {
    const registry = make()
    registry.resolve('s1', tokens())
    registry.clearSettled()

    const status = await Promise.race([
      registry.waitFor('s1').then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])
    expect(status).toBe('pending')
  })
})
