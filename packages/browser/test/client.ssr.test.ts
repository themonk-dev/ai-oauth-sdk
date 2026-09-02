/*
 * Deliberately runs in the default `node` environment: no `sessionStorage`, no
 * `window`, no `WorkerGlobalScope` — exactly what `createBrowserAuthClient()`
 * sees when a `"use client"` module is evaluated during server-side rendering.
 */
import { describe, expect, it } from 'vitest'

import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { createBrowserAuthClient } from '../src/index.js'

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
