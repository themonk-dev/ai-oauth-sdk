/**
 * Regressions for the issues found in the pre-release review.
 *
 * Each test fails against the code as it stood before the fix, so they document
 * the behaviour rather than merely exercising it.
 */
import { describe, expect, it, vi } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import { defineProvider } from '../src/providers/define.js'
import { startDeviceAuthorization } from '../src/receivers/device.js'
import { AuthorizationRegistry } from '../src/registry.js'
import { fromSyncStorage, memoryStorage, prefixedStorage } from '../src/storage.js'
import type { CallbackReceiver, CallbackResult, TokenSet } from '../src/types.js'

const tokenResponse = () =>
  new Response(
    JSON.stringify({ access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

const provider = defineProvider({
  id: 'demo',
  label: 'Demo',
  clientId: 'demo-client',
  authorizationUrl: 'https://provider.invalid/authorize',
  tokenUrl: 'https://provider.invalid/token',
  scopes: [],
  redirect: { mode: 'custom' },
})

/** A receiver that returns whatever callback the test hands it. */
function fixedReceiver(result: CallbackResult | (() => CallbackResult)): CallbackReceiver {
  return {
    id: 'fixed',
    async start() {
      return {
        redirectUri: 'http://127.0.0.1:9999/cb',
        async present() {},
        async wait() {
          return typeof result === 'function' ? result() : result
        },
        async close() {},
      }
    },
  }
}

describe('login() requires a verifiable state', () => {
  it('rejects a callback that carries no state at all', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const client = createAuthClient({ provider, storage: memoryStorage(), fetch: fetchImpl })

    // An attacker reaching the loopback port supplies a code and simply omits
    // `state`; that must not be a way to skip the check.
    await expect(client.login({ receiver: fixedReceiver({ code: 'INJECTED' }) })).rejects.toMatchObject({
      code: 'state_mismatch',
    })
    expect(fetchImpl, 'no code should have been exchanged').not.toHaveBeenCalled()
  })

  it('still rejects a callback whose state is wrong', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse())
    const client = createAuthClient({ provider, storage: memoryStorage(), fetch: fetchImpl })

    await expect(
      client.login({ receiver: fixedReceiver({ code: 'INJECTED', state: 'not-ours' }) }),
    ).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts the state it issued', async () => {
    const client = createAuthClient({ provider, storage: memoryStorage(), fetch: async () => tokenResponse() })

    let issued: string | undefined
    const receiver: CallbackReceiver = {
      id: 'echo',
      async start() {
        return {
          redirectUri: 'http://127.0.0.1:9999/cb',
          async present(url) {
            issued = new URL(url).searchParams.get('state') ?? undefined
          },
          async wait() {
            return { code: 'good', state: issued! }
          },
          async close() {},
        }
      },
    }

    await expect(client.login({ receiver })).resolves.toMatchObject({ accessToken: 'AT' })
  })

  it('exempts providers that documented they never echo state', async () => {
    // OpenRouter's shape: no state anywhere in the flow.
    const stateless = defineProvider({
      ...provider,
      id: 'stateless',
      echoesState: false,
    })
    const client = createAuthClient({
      provider: stateless,
      storage: memoryStorage(),
      fetch: async () => tokenResponse(),
    })

    await expect(client.login({ receiver: fixedReceiver({ code: 'ok' }) })).resolves.toMatchObject({
      accessToken: 'AT',
    })
  })
})

describe('storage adapters keep keys() so prune() works', () => {
  /** The three methods every store has, over a plain Map. */
  function fakeWebStorage() {
    const map = new Map<string, string>()

    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      get length() {
        return map.size
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      _size: () => map.size,
    }
  }

  it('fromSyncStorage exposes keys() when the store can enumerate', async () => {
    const storage = fromSyncStorage(fakeWebStorage())
    expect(storage.keys).toBeTypeOf('function')
  })

  it('fromSyncStorage omits keys() when it cannot', async () => {
    // A minimal three-method store — nothing to enumerate with.
    const storage = fromSyncStorage({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    expect(storage.keys).toBeUndefined()
  })

  it('sweeps abandoned logins out of a web store', async () => {
    const backing = fakeWebStorage()
    const registry = new AuthorizationRegistry({ storage: fromSyncStorage(backing), ttlMs: 1 })

    for (let i = 0; i < 5; i++) {
      await registry.create({
        state: `s${i}`,
        provider: 'demo',
        redirectUri: 'http://x/cb',
        codeVerifier: `verifier-${i}`,
      })
    }

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await registry.prune()).toBe(5)
    // The PKCE verifiers are gone; nothing is left pointing at them either.
    expect(backing._size()).toBe(0)
  })

  it('prefixedStorage forwards keys(), filtered and unprefixed', async () => {
    const backing = memoryStorage()
    await backing.set('other:thing', '1')
    const scoped = prefixedStorage(backing, 'app:')

    await scoped.set('a', '1')
    await scoped.set('b', '2')

    expect(await scoped.keys?.()).toEqual(['a', 'b'])
    // The backing store still sees them namespaced.
    expect(await backing.keys?.()).toContain('app:a')
  })

  it('prefixedStorage omits keys() when the backing store has none', () => {
    const bare = { get: async () => null, set: async () => {}, delete: async () => {} }
    expect(prefixedStorage(bare, 'app:').keys).toBeUndefined()
  })
})

describe('the latest-flow pointer does not outlive its record', () => {
  it('is cleared when the flow is consumed', async () => {
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage })

    await registry.create({ state: 'st', provider: 'demo', redirectUri: 'http://x/cb' })
    expect(await storage.get('pending-latest:demo')).toBe('st')

    await registry.consume('st')
    expect(await storage.get('pending-latest:demo')).toBeNull()
    expect(await storage.keys?.()).toEqual([])
  })

  it('is cleared when the flow is cancelled', async () => {
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage })

    await registry.create({ state: 'st', provider: 'demo', redirectUri: 'http://x/cb' })
    await registry.delete('st')
    expect(await storage.keys?.()).toEqual([])
  })

  it('leaves a pointer that names a different, still-live flow', async () => {
    const storage = memoryStorage()
    const registry = new AuthorizationRegistry({ storage })

    await registry.create({ state: 'first', provider: 'demo', redirectUri: 'http://x/cb' })
    await registry.create({ state: 'second', provider: 'demo', redirectUri: 'http://x/cb' })
    // Completing the older flow must not orphan the newer one.
    await registry.consume('first')

    expect(await storage.get('pending-latest:demo')).toBe('second')
  })
})

describe('device authorization clamps what the server reports', () => {
  const deviceProvider = defineProvider({
    ...provider,
    deviceAuthorizationUrl: 'https://provider.invalid/device',
  })

  const start = (body: Record<string, unknown>) =>
    startDeviceAuthorization({
      provider: deviceProvider,
      clientId: 'c',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'uc',
            verification_uri: 'https://provider.invalid/v',
            ...body,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })

  it('floors interval: 0, which would otherwise poll with no delay', async () => {
    expect((await start({ interval: 0 })).intervalMs).toBe(1000)
  })

  it('floors a negative interval', async () => {
    expect((await start({ interval: -5 })).intervalMs).toBe(1000)
  })

  it('caps an absurd interval', async () => {
    expect((await start({ interval: 86_400 })).intervalMs).toBe(60_000)
  })

  it('honours a sane interval unchanged', async () => {
    expect((await start({ interval: 7 })).intervalMs).toBe(7000)
  })

  it('defaults when the field is missing or not a number', async () => {
    expect((await start({})).intervalMs).toBe(5000)
    expect((await start({ interval: 'soon' })).intervalMs).toBe(5000)
    expect((await start({ interval: Number.NaN })).intervalMs).toBe(5000)
  })
})

describe('the 401 retry never replays a drained body', () => {
  async function clientWithToken(): Promise<ReturnType<typeof createAuthClient>> {
    const client = createAuthClient({
      provider,
      storage: memoryStorage(),
      fetch: async () => tokenResponse(),
    })
    const tokens: TokenSet = {
      accessToken: 'AT1',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      provider: 'demo',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    }
    await client.setTokens(tokens)

    return client
  }

  it('returns the 401 rather than throwing when the body is a stream', async () => {
    const client = await clientWithToken()
    const seen: string[] = []

    const api = createAuthenticatedFetch(client, {
      fetch: async (_url, init) => {
        seen.push(init?.body ? await new Response(init.body as BodyInit).text() : '<none>')

        return new Response('', { status: 401 })
      },
    })

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prompt":"hi"}'))
        controller.close()
      },
    })

    const response = await api('https://api.invalid/v1/chat', {
      method: 'POST',
      body,
      // Node requires this for a stream body.
      ...({ duplex: 'half' } as object),
    })

    expect(response.status).toBe(401)
    expect(seen, 'the stream must be sent exactly once').toEqual(['{"prompt":"hi"}'])
  })

  it('still retries a string body', async () => {
    const client = await clientWithToken()
    const seen: string[] = []

    const api = createAuthenticatedFetch(client, {
      fetch: async (_url, init) => {
        seen.push(String(init?.body))

        return new Response('', { status: seen.length === 1 ? 401 : 200 })
      },
    })

    const response = await api('https://api.invalid/v1/chat', {
      method: 'POST',
      body: '{"prompt":"hi"}',
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual(['{"prompt":"hi"}', '{"prompt":"hi"}'])
  })
})

describe('authorizationHeader reflects the post-refresh token', () => {
  it('pairs the new token with the new token type', async () => {
    const client = createAuthClient({
      provider,
      storage: memoryStorage(),
      fetch: async () =>
        new Response(
          JSON.stringify({ access_token: 'FRESH', token_type: 'DPoP', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    // An expired token with a different type, as the previous grant left it.
    await client.setTokens({
      accessToken: 'STALE',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      provider: 'demo',
      expiresAt: Date.now() - 1000,
      raw: {},
    })

    expect(await client.authorizationHeader()).toBe('DPoP FRESH')
  })
})
