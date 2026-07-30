import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { OAuthError } from '../src/errors.js'
import { defineProvider } from '../src/providers/define.js'
import { createAuthStore, type AuthState } from '../src/store.js'
import { memoryStorage } from '../src/storage.js'
import type { AuthStorage, CallbackReceiver, ProviderConfig } from '../src/types.js'
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

/** A receiver that drives the fake authorization endpoint itself. */
const scriptedReceiver = (redirectUri = 'http://localhost:9999/callback'): CallbackReceiver => ({
  id: 'scripted',
  async start() {
    let result: Promise<{ code: string; state: string }> | undefined
    return {
      redirectUri,
      async present(url) {
        result = fetch(url, { redirect: 'manual' }).then((response) => {
          const params = new URL(response.headers.get('location')!).searchParams
          return { code: params.get('code')!, state: params.get('state')! }
        })
      },
      wait: () => result!,
      async close() {},
    }
  },
})

/** A receiver that never completes, for testing cancellation. */
const hangingReceiver = (): CallbackReceiver => ({
  id: 'hanging',
  async start() {
    return {
      redirectUri: 'http://localhost:9999/callback',
      async present() {},
      wait: () => new Promise<never>(() => {}),
      async close() {},
    }
  },
})

function makeStore(storage: AuthStorage = memoryStorage(), receiver = scriptedReceiver()) {
  const client = createAuthClient({ provider: testProvider(server.url), storage })
  return createAuthStore({ client, receiver })
}

beforeEach(async () => {
  server = await startFakeAuthServer()
})

afterEach(async () => {
  await server.close()
})

describe('createAuthStore', () => {
  it('starts signed out', () => {
    expect(makeStore().getState()).toEqual({
      tokens: undefined,
      isAuthenticated: false,
      isLoading: false,
      error: undefined,
    })
  })

  it('emits the current state on subscribe (Svelte store contract)', () => {
    const store = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)

    // Must fire synchronously with the current value, not wait for a change.
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ isAuthenticated: false })
  })

  it('returns an unsubscribe that actually stops updates', async () => {
    const store = makeStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    listener.mockClear()

    unsubscribe()
    await store.login()
    expect(listener).not.toHaveBeenCalled()
  })

  it('drives isLoading and tokens through a login', async () => {
    const store = makeStore()
    const states: AuthState[] = []
    store.subscribe((state) => states.push({ ...state }))

    const tokens = await store.login()

    expect(tokens?.accessToken).toBe('access-1')
    expect(store.getState().isAuthenticated).toBe(true)
    expect(store.getState().isLoading).toBe(false)
    // Loading must have been true at some point in between.
    expect(states.some((state) => state.isLoading)).toBe(true)
  })

  it('calls onSuccess with the tokens', async () => {
    const onSuccess = vi.fn()
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    const store = createAuthStore({ client, receiver: scriptedReceiver(), onSuccess })

    await store.login()
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onSuccess.mock.calls[0]?.[0]).toMatchObject({ accessToken: 'access-1' })
  })

  it('records an error without throwing', async () => {
    const failing = await startFakeAuthServer({ failWith: 'invalid_grant' })
    try {
      const onError = vi.fn()
      const client = createAuthClient({
        provider: testProvider(failing.url),
        storage: memoryStorage(),
      })
      const store = createAuthStore({ client, receiver: scriptedReceiver(), onError })

      // Returns undefined rather than rejecting: UI code should not need a try.
      await expect(store.login()).resolves.toBeUndefined()
      expect(store.getState().error).toBeInstanceOf(Error)
      expect(store.getState().isLoading).toBe(false)
      expect(onError).toHaveBeenCalledOnce()
    } finally {
      await failing.close()
    }
  })

  it('treats cancellation as a non-error', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    const onError = vi.fn()
    const store = createAuthStore({ client, receiver: hangingReceiver(), onError })

    const pending = store.login()
    // Give login a turn to reach the receiver before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20))
    store.cancel()

    await expect(pending).resolves.toBeUndefined()
    // Closing a popup is a user action, not something to show as a failure.
    expect(store.getState().error).toBeUndefined()
    expect(store.getState().isLoading).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('supersedes an in-flight login rather than racing it', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    const store = createAuthStore({ client, receiver: hangingReceiver() })

    const first = store.login()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = store.login({ receiver: scriptedReceiver() })

    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toMatchObject({ accessToken: 'access-1' })
  })

  it('reports a missing receiver instead of throwing', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    const store = createAuthStore({ client })

    await expect(store.login()).resolves.toBeUndefined()
    expect(store.getState().error?.message).toMatch(/No receiver configured/)
  })

  it('accepts a per-call receiver when none was configured', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    const store = createAuthStore({ client })

    await expect(store.login({ receiver: scriptedReceiver() })).resolves.toMatchObject({
      accessToken: 'access-1',
    })
  })

  it('restores a persisted session', async () => {
    const storage = memoryStorage()
    await makeStore(storage).login()

    // A fresh store over the same storage — as after a page reload.
    const restored = makeStore(storage)
    expect(restored.getState().isAuthenticated).toBe(false)
    await restored.restore()
    expect(restored.getState().isAuthenticated).toBe(true)
  })

  it('clears state on logout', async () => {
    const store = makeStore()
    await store.login()
    await store.logout()

    expect(store.getState().tokens).toBeUndefined()
    expect(store.getState().isAuthenticated).toBe(false)
  })

  it('updates observers after a refresh', async () => {
    const store = makeStore()
    await store.login()

    const refreshed = await store.refresh()
    expect(refreshed?.accessToken).toBe('access-2')
    expect(store.getState().tokens?.accessToken).toBe('access-2')
  })

  it('records a refresh failure in state', async () => {
    const store = makeStore()
    await store.login()
    await store.client.setTokens({ ...(await store.client.getTokens())!, refreshToken: undefined })

    await expect(store.refresh()).resolves.toBeUndefined()
    expect(store.getState().error).toBeInstanceOf(OAuthError)
  })

  it('syncs state when getAccessToken triggers a refresh', async () => {
    const shortLived = await startFakeAuthServer({ expiresIn: 1 })
    try {
      const client = createAuthClient({
        provider: testProvider(shortLived.url),
        storage: memoryStorage(),
      })
      const store = createAuthStore({ client, receiver: scriptedReceiver() })
      await store.login()

      const accessToken = await store.getAccessToken()
      expect(accessToken).toBe('access-2')
      // Observers must see the new token, not the one login returned.
      expect(store.getState().tokens?.accessToken).toBe('access-2')
    } finally {
      await shortLived.close()
    }
  })

  it('suppresses notifications when state does not actually move', async () => {
    const store = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    listener.mockClear()

    // Already signed out; logging out again changes nothing observable.
    await store.logout()
    expect(listener).not.toHaveBeenCalled()

    await store.logout()
    expect(listener).not.toHaveBeenCalled()
  })

  it('still reports the loading transitions of a restore', async () => {
    const store = makeStore()
    const seen: boolean[] = []
    store.subscribe((state) => seen.push(state.isLoading))

    await store.restore()
    // Storage can be slow (SecureStore, keychain), so a spinner needs both
    // edges even when there turns out to be nothing stored.
    expect(seen).toContain(true)
    expect(seen.at(-1)).toBe(false)
  })

  it('serves several independent subscribers', async () => {
    const store = makeStore()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe(a)
    store.subscribe(b)

    await store.login()
    expect(a.mock.calls.length).toBeGreaterThan(1)
    expect(b.mock.calls.length).toBeGreaterThan(1)
  })

  it('stops emitting after destroy', async () => {
    const store = makeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.destroy()
    listener.mockClear()

    await store.restore()
    expect(listener).not.toHaveBeenCalled()
  })
})
