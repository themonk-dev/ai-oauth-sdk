import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { defineProvider } from '../src/providers/define.js'
import { memoryStorage, prefixedStorage } from '../src/storage.js'
import type { ProviderConfig } from '../src/types.js'
import { startFakeAuthServer, type FakeAuthServer } from './helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    scopes: ['openid'],
    redirect: { mode: 'loopback', loopbackPort: 0 },
  })

async function followAuthorization(
  authorizationUrl: string,
): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = response.headers.get('location')!
  const params = new URL(location).searchParams

  return { code: params.get('code')!, state: params.get('state')! }
}

beforeEach(async () => {
  // The gate covers a read-then-delete that is two awaits into storage. Delaying
  // the token endpoint widens the window enough that an ungated second caller
  // reliably gets in, so this pins the serialisation rather than a lucky order.
  server = await startFakeAuthServer({ delayMs: 50 })
})

afterEach(async () => {
  await server.close()
})

/**
 * SECURITY.md says callbacks arriving together for one `state` are serialised
 * "per process". These pin that wording, which was previously true only per
 * `AuthClient`: the registry holding the gate is built in the client's
 * constructor, so a server building a client per request — the shape
 * `recipes/multi-user` documents — had every concurrent callback in a gate of
 * its own and got two exchanges of one code with one verifier.
 */
describe('concurrent consume of one pending authorization', () => {
  it('serialises two callbacks on one client', async () => {
    const storage = memoryStorage()
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage,
    })

    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    const results = await Promise.allSettled([
      client.completeAuthorization({ code, state }),
      client.completeAuthorization({ code, state }),
    ])

    expect(server.requests).toHaveLength(1)
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('serialises two callbacks across two clients over one store', async () => {
    const storage = memoryStorage()
    const options = {
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage,
    }

    const first = createAuthClient(options)
    const second = createAuthClient(options)

    const authorization = await first.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    const results = await Promise.allSettled([
      first.completeAuthorization({ code, state }),
      second.completeAuthorization({ code, state }),
    ])

    // The reuse is what costs: RFC 6749 §4.1.2 lets the server revoke every
    // token issued for a code it sees twice, taking out the session the winner
    // had just established.
    expect(server.requests).toHaveLength(1)
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('serialises across per-request clients wrapping one store, as the multi-user recipe builds them', async () => {
    const shared = memoryStorage()
    const provider = testProvider(server.url)
    // A fresh `prefixedStorage` wrapper per request, exactly as `clientFor()`
    // in `recipes/multi-user` does. Keying the gate on the storage object would
    // not catch this: the wrapper is a new object every time.
    const clientFor = () =>
      createAuthClient({
        provider,
        redirectUri: 'http://localhost:9999/callback',
        storage: prefixedStorage(shared, 'user:alice:'),
      })

    const authorization = await clientFor().createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    const results = await Promise.allSettled([
      clientFor().completeAuthorization({ code, state }),
      clientFor().completeAuthorization({ code, state }),
    ])

    expect(server.requests).toHaveLength(1)
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('still lets two unrelated logins run at once', async () => {
    const provider = testProvider(server.url)
    const alice = createAuthClient({
      provider,
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const bob = createAuthClient({
      provider,
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })

    const [aliceAuth, bobAuth] = await Promise.all([
      alice.createAuthorization(),
      bob.createAuthorization(),
    ])
    const [aliceCb, bobCb] = await Promise.all([
      followAuthorization(aliceAuth.url),
      followAuthorization(bobAuth.url),
    ])

    // Distinct states, so one shared map must not make these queue behind each
    // other or, worse, hand one user the other's record.
    const results = await Promise.all([
      alice.completeAuthorization(aliceCb),
      bob.completeAuthorization(bobCb),
    ])

    expect(server.requests).toHaveLength(2)
    expect(results.every((tokens) => tokens.accessToken.length > 0)).toBe(true)
    expect(await alice.isAuthenticated()).toBe(true)
    expect(await bob.isAuthenticated()).toBe(true)
  })
})
