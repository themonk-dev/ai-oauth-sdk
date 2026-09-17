// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { createBrowserAuthClient } from '../src/index.js'
import { handleRedirectCallback } from '../src/redirect.js'
import { startFakeAuthServer, type FakeAuthServer } from '../../core/test/helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    scopes: ['openid'],
    redirect: { mode: 'custom' },
  })

const pendingKeys = () => Object.keys(sessionStorage).filter((key) => key.startsWith('pending:'))

beforeEach(async () => {
  server = await startFakeAuthServer()
  sessionStorage.clear()
})

afterEach(async () => {
  await server.close()
})

describe('createBrowserAuthClient', () => {
  it('defaults to sessionStorage', async () => {
    const client = createBrowserAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost/callback',
    })

    await client.createAuthorization()
    expect(pendingKeys()).toHaveLength(1)
  })

  it('still defaults to sessionStorage when `storage` is present but undefined', async () => {
    // `{ storage: props.storage }` is how an optional prop is normally
    // forwarded, and it puts the key in the object with the value `undefined`.
    // Spreading the caller's options over a default let that key erase it, and
    // core then quietly substituted `memoryStorage()`.
    const client = createBrowserAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost/callback',
      storage: undefined,
    })

    await client.createAuthorization()
    expect(pendingKeys()).toHaveLength(1)
  })

  it('completes a redirect round trip with `storage: undefined`', async () => {
    // The damage is specific to flows that cross a page load: the popup flow
    // keeps the pending record on the same live instance, but the redirect
    // flow rebuilds the client after the navigation and has only storage to
    // read it back from. In memory, that fails at the *end* of the round trip,
    // after the user has already consented.
    const options = {
      provider: testProvider(server.url),
      redirectUri: 'http://localhost/callback',
      storage: undefined,
    }

    const { url, state } = await createBrowserAuthClient(options).createAuthorization()
    const response = await fetch(url, { redirect: 'manual' })
    const callbackUrl = response.headers.get('location')!
    expect(new URL(callbackUrl).searchParams.get('state')).toBe(state)

    // A *new* client over the same sessionStorage, as after the page reloads.
    const reloaded = createBrowserAuthClient(options)
    const tokens = await handleRedirectCallback(reloaded, { url: callbackUrl })

    expect(tokens?.accessToken).toBe('access-1')
  })

  it('honours an explicit storage adapter', async () => {
    const records = new Map<string, string>()
    const client = createBrowserAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost/callback',
      storage: {
        get: async (key) => records.get(key) ?? null,
        set: async (key, value) => void records.set(key, value),
        delete: async (key) => void records.delete(key),
        keys: async () => [...records.keys()],
      },
    })

    await client.createAuthorization()
    expect([...records.keys()].filter((key) => key.startsWith('pending:'))).toHaveLength(1)
    expect(pendingKeys()).toEqual([])
  })
})
