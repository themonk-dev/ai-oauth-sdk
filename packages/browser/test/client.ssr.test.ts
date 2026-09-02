/*
 * Deliberately runs in the default `node` environment: no `sessionStorage`, no
 * `window`, no `WorkerGlobalScope` — exactly what `createBrowserAuthClient()`
 * sees when a `"use client"` module is evaluated during server-side rendering.
 */
import { describe, expect, it } from 'vitest'

import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { createBrowserAuthClient } from '../src/index.js'
import { localStorageAdapter } from '../src/storage.js'

const testProvider = (): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    scopes: ['openid'],
    redirect: { mode: 'custom' },
  })

describe('createBrowserAuthClient off-browser', () => {
  it('constructs without throwing, because SSR runs render bodies too', () => {
    expect(() =>
      createBrowserAuthClient({
        provider: testProvider(),
        redirectUri: 'http://localhost/callback',
      }),
    ).not.toThrow()
  })

  it('refuses to store a PKCE verifier on the server', async () => {
    const client = createBrowserAuthClient({
      provider: testProvider(),
      redirectUri: 'http://localhost/callback',
    })

    await expect(client.createAuthorization()).rejects.toMatchObject({
      code: 'unsupported_runtime',
    })
  })

  it('still refuses when `storage` is present but undefined', async () => {
    // The refusing adapter was constructed and then thrown away by the
    // explicit `undefined`, so core substituted `memoryStorage()` and the
    // server render went on to store the verifier — silently disabling a
    // guard whose whole job is to be loud.
    const client = createBrowserAuthClient({
      provider: testProvider(),
      redirectUri: 'http://localhost/callback',
      storage: undefined,
    })

    await expect(client.createAuthorization()).rejects.toMatchObject({
      code: 'unsupported_runtime',
    })
  })
})

/*
 * Node ships Web Storage on by default from v26, so a server render there finds
 * a working `localStorage`/`sessionStorage` with no document behind it. Both are
 * process-global — `localStorage` is a file, `sessionStorage` outlives the
 * request — so trusting them on the server pools every request's PKCE verifier
 * and tokens into one store, which is the case the refusal exists for. Deno and
 * Bun expose the same globals server-side.
 *
 * Simulated rather than version-gated, so the guard is exercised on every Node.
 */
describe('a server runtime that provides web storage anyway', () => {
  const withStorageGlobals = async (run: () => Promise<void>) => {
    const store = () => {
      const map = new Map<string, string>()

      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        key: (i: number) => [...map.keys()][i] ?? null,
        clear: () => map.clear(),
        get length() {
          return map.size
        },
      }
    }

    Object.assign(globalThis, { localStorage: store(), sessionStorage: store() })

    try {
      await run()
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage')
      Reflect.deleteProperty(globalThis, 'sessionStorage')
    }
  }

  it('still refuses, because there is no document behind the storage', async () => {
    await withStorageGlobals(async () => {
      expect(typeof sessionStorage).toBe('object')
      expect(typeof window).toBe('undefined')

      const client = createBrowserAuthClient({
        provider: testProvider(),
        redirectUri: 'http://localhost/callback',
      })

      await expect(client.createAuthorization()).rejects.toMatchObject({
        code: 'unsupported_runtime',
      })
    })
  })

  it('refuses through localStorageAdapter too', async () => {
    await withStorageGlobals(async () => {
      await expect(localStorageAdapter().get('k')).rejects.toMatchObject({
        code: 'unsupported_runtime',
      })
    })
  })
})
