// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuthClient, defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { handleRedirectCallback } from '../src/redirect.js'
import {
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../core/test/helpers/fakeAuthServer.js'

/**
 * No DOM, deliberately.
 *
 * The rest of the browser suite opts into jsdom, which is the runtime this
 * package is for — but not the only one its module graph is loaded in. An app
 * that renders on the server imports the SDK there too, and the documented
 * "safe to call unconditionally at startup" `await handleRedirectCallback()`
 * then runs with no `window` anywhere. These tests pin that: they would pass
 * under jsdom whatever the code did, so the environment is the assertion.
 */

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

/** Default in-memory storage: there is no web storage out here either. */
const makeClient = (url: string) =>
  createAuthClient({
    provider: testProvider(url),
    redirectUri: 'http://localhost/callback',
  })

beforeEach(async () => {
  server = await startFakeAuthServer()
})

afterEach(async () => {
  await server.close()
})

describe('handleRedirectCallback under server rendering', () => {
  it('returns null instead of throwing where there is no window', async () => {
    expect(typeof window).toBe('undefined')

    // Reading the address bar is the only thing that needs a browser, and
    // there is no address bar to read: nothing to complete, so nothing to do.
    // Throwing here fails the whole server render of an app that merely
    // imported the SDK.
    await expect(handleRedirectCallback(makeClient(server.url))).resolves.toBeNull()
  })

  it('still completes an explicit callback URL with no window at all', async () => {
    const client = makeClient(server.url)
    const { url } = await client.createAuthorization()
    const response = await fetch(url, { redirect: 'manual' })
    const callbackUrl = response.headers.get('location')!

    // A caller that hands over the URL is not reading the address bar, so the
    // absence of a window is beside the point — this is how a deep link or a
    // framework's own request URL gets completed, and guarding the function as
    // a whole rather than that one read would break it. `cleanUrl` is left at
    // its default of true on purpose: the clean-up is skipped for an explicit
    // URL rather than attempted and rescued, and that `finally` block runs on
    // the success path too, so a window read there would throw out of a login
    // that had already fetched its tokens.
    const tokens = await handleRedirectCallback(client, { url: callbackUrl })

    expect(tokens?.accessToken).toBe('access-1')
  })
})
