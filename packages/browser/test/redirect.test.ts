// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAuthClient, defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { handleRedirectCallback, redirectReceiver, startRedirectLogin } from '../src/redirect.js'
import { sessionStorageAdapter } from '../src/storage.js'
import {
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../core/test/helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    scopes: ['openid'],
    redirect: { mode: 'custom' },
    ...overrides,
  })

const makeClient = (url: string, overrides: Partial<ProviderConfig> = {}) =>
  createAuthClient({
    provider: testProvider(url, overrides),
    redirectUri: 'http://localhost/callback',
    storage: sessionStorageAdapter(),
  })

let realLocation: Location

beforeEach(async () => {
  server = await startFakeAuthServer()
  sessionStorage.clear()
  realLocation = window.location
  window.history.replaceState({}, '', 'http://localhost/')
})

afterEach(async () => {
  await server.close()
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true })
  vi.restoreAllMocks()
})

/**
 * Replaces `window.location` wholesale.
 *
 * jsdom 30 defines `assign`/`replace` as non-configurable, so `vi.spyOn` throws
 * — swapping the whole object is the only way to observe a navigation.
 */
function stubNavigation(): { assign: string[]; replace: string[] } {
  const calls = { assign: [] as string[], replace: [] as string[] }
  const stub = {
    ...realLocation,
    href: realLocation.href,
    origin: realLocation.origin,
    pathname: realLocation.pathname,
    search: realLocation.search,
    hash: realLocation.hash,
    assign: (url: string) => calls.assign.push(url),
    replace: (url: string) => calls.replace.push(url),
  }
  Object.defineProperty(window, 'location', { value: stub, configurable: true })

  return calls
}

describe('handleRedirectCallback', () => {
  it('returns null when the URL is not a callback', async () => {
    // Safe to call unconditionally at app startup.
    await expect(handleRedirectCallback(makeClient(server.url))).resolves.toBeNull()
  })

  it('completes a flow that spans a page navigation', async () => {
    const client = makeClient(server.url)
    const { url, state } = await client.createAuthorization()

    // Simulate the round trip: the provider hands back a code.
    const response = await fetch(url, { redirect: 'manual' })
    const callbackUrl = response.headers.get('location')!

    // A *new* client over the same sessionStorage, as after a reload.
    const reloaded = makeClient(server.url)
    const tokens = await handleRedirectCallback(reloaded, { url: callbackUrl })

    expect(tokens?.accessToken).toBe('access-1')
    expect(new URL(callbackUrl).searchParams.get('state')).toBe(state)
  })

  it('strips the OAuth params from the address bar', async () => {
    const client = makeClient(server.url)
    const { url } = await client.createAuthorization()
    const response = await fetch(url, { redirect: 'manual' })
    const callbackUrl = new URL(response.headers.get('location')!)

    window.history.replaceState({}, '', `/callback${callbackUrl.search}&keep=yes`)
    // No explicit url: the real usage, reading straight from the address bar.
    await handleRedirectCallback(client)

    // A stale ?code= in the URL would be re-submitted on refresh.
    expect(window.location.search).not.toContain('code=')
    expect(window.location.search).not.toContain('state=')
    // Unrelated params survive.
    expect(window.location.search).toContain('keep=yes')
  })

  it('leaves the address bar alone when given an explicit URL', async () => {
    const client = makeClient(server.url)
    const { url } = await client.createAuthorization()
    const response = await fetch(url, { redirect: 'manual' })
    const callbackUrl = response.headers.get('location')!

    window.history.replaceState({}, '', '/somewhere-else?keep=yes')
    await handleRedirectCallback(client, { url: callbackUrl })

    // The caller was parsing something else — a stored deep link, a fixture —
    // so navigating the page would be wrong.
    expect(window.location.pathname).toBe('/somewhere-else')
    expect(window.location.search).toBe('?keep=yes')
  })

  it('leaves the URL alone when asked', async () => {
    const client = makeClient(server.url)
    const { url } = await client.createAuthorization()
    const response = await fetch(url, { redirect: 'manual' })
    const search = new URL(response.headers.get('location')!).search

    window.history.replaceState({}, '', `/callback${search}`)
    await handleRedirectCallback(client, { url: window.location.href, cleanUrl: false })

    expect(window.location.search).toContain('code=')
  })

  it('surfaces a provider denial and still cleans the URL', async () => {
    const client = makeClient(server.url)
    window.history.replaceState({}, '', '/callback?error=access_denied&error_description=nope')

    await expect(handleRedirectCallback(client)).rejects.toMatchObject({
      code: 'authorization_denied',
    })

    expect(window.location.search).not.toContain('error=')
  })

  it('persists the verifier in sessionStorage across the navigation', async () => {
    const client = makeClient(server.url)
    const { state } = await client.createAuthorization()

    // This is what makes the redirect flow work at all.
    const stored = sessionStorage.getItem(`pending:${state}`)
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!)).toMatchObject({ state, codeVerifier: expect.any(String) })
  })
})

describe('redirectReceiver', () => {
  it('navigates with replace by default', async () => {
    const calls = stubNavigation()
    const started = await redirectReceiver().start({ provider: testProvider(server.url) })

    await started.present('https://provider.test/authorize?x=1')
    // replace, not assign: login should not add a history entry to go "back" to.
    expect(calls.replace).toEqual(['https://provider.test/authorize?x=1'])
    expect(calls.assign).toEqual([])
  })

  it('can use assign instead', async () => {
    const calls = stubNavigation()
    const started = await redirectReceiver({ replace: false }).start({
      provider: testProvider(server.url),
    })

    await started.present('https://provider.test/authorize?x=1')
    expect(calls.assign).toHaveLength(1)
    expect(calls.replace).toEqual([])
  })

  it('defaults its redirect URI to the current page', async () => {
    window.history.replaceState({}, '', '/app/page?q=1')
    const started = await redirectReceiver().start({ provider: testProvider(server.url) })
    expect(started.redirectUri).toBe('http://localhost/app/page?q=1')
  })

  it('never resolves wait(), because the document is unloading', async () => {
    const started = await redirectReceiver().start({ provider: testProvider(server.url) })
    const settled = await Promise.race([
      started.wait().then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 50)),
    ])
    expect(settled).toBe('still pending')
  })
})

describe('startRedirectLogin', () => {
  it('persists the flow before navigating away', async () => {
    const calls = stubNavigation()
    const client = makeClient(server.url)

    void startRedirectLogin(client)
    await vi.waitFor(() => expect(calls.replace.length).toBe(1))

    // The pending record must be written before the page unloads, or the
    // verifier is lost and the callback can never be completed.
    const pendingKeys = Object.keys(sessionStorage).filter((key) => key.startsWith('pending:'))
    expect(pendingKeys.length).toBeGreaterThan(0)

    const target = new URL(calls.replace[0]!)
    expect(target.searchParams.get('code_challenge')).toBeTruthy()
  })
})
