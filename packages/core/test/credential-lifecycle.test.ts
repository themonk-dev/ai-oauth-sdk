/**
 * Regressions for credentials that outlived the flow they belonged to.
 *
 * Every test here fails against the code as it stood before the fix: a refresh
 * or a login landing after a `logout()`, a credential left under a renamed
 * provider's key, one pending record consumed by two clients, and a PKCE
 * verifier left at rest by an abandoned login.
 */
import { describe, expect, it, vi } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { defineProvider } from '../src/providers/define.js'
import { memoryStorage } from '../src/storage.js'
import { createAuthStore } from '../src/store.js'
import type { AuthStorage, CallbackReceiver, TokenSet } from '../src/types.js'

const provider = defineProvider({
  id: 'demo',
  label: 'Demo',
  clientId: 'demo-client',
  authorizationUrl: 'https://provider.invalid/authorize',
  tokenUrl: 'https://provider.invalid/token',
  revocationUrl: 'https://provider.invalid/revoke',
  scopes: [],
  redirect: { mode: 'custom' },
})

const stored = (overrides: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'AT1',
  refreshToken: 'RT1',
  tokenType: 'Bearer',
  expiresAt: Date.now() + 3_600_000,
  provider: 'demo',
  raw: {},
  ...overrides,
})

const tokenResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })

  return { promise, resolve }
}

/** A receiver that hands back the state it was presented, when released. */
function gatedReceiver(release: Promise<void>): CallbackReceiver {
  return {
    id: 'gated',
    async start() {
      let presented: string | undefined

      return {
        redirectUri: 'http://127.0.0.1:9999/cb',
        async present(url: string) {
          presented = new URL(url).searchParams.get('state') ?? undefined
        },
        async wait() {
          await release

          return { code: 'CODE', ...(presented ? { state: presented } : {}) }
        },
        async close() {},
      }
    },
  }
}

describe('logout() fences a refresh that started before it', () => {
  it('discards the rotated credential rather than writing it back', async () => {
    const storage = memoryStorage()
    const gate = deferred<Response>()
    const fetchImpl = vi.fn(async () => gate.promise)
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    await client.setTokens(stored())

    const refreshing = client.refresh()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())

    await client.logout()
    expect(await client.isAuthenticated()).toBe(false)

    // The provider answers only now, with a *rotated* refresh token. Writing it
    // would leave a live credential nothing has revoked.
    gate.resolve(
      tokenResponse({ access_token: 'AT2', refresh_token: 'RT2', token_type: 'Bearer', expires_in: 3600 }),
    )

    await expect(refreshing).rejects.toMatchObject({ code: 'aborted' })
    expect(await client.isAuthenticated()).toBe(false)
    expect(await client.getTokens()).toBeUndefined()
    expect(await storage.get('tokens:demo'), 'no credential may survive the sign-out').toBeNull()
  })

  it('still revokes the refresh token the user actually held', async () => {
    const storage = memoryStorage()
    const gate = deferred<Response>()
    const posted: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ''))

      return String(input).endsWith('/revoke') ? new Response(null, { status: 200 }) : gate.promise
    })
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    await client.setTokens(stored())

    const refreshing = client.refresh()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())

    await client.logout({ revoke: true })
    gate.resolve(
      tokenResponse({ access_token: 'AT2', refresh_token: 'RT2', token_type: 'Bearer', expires_in: 3600 }),
    )
    await expect(refreshing).rejects.toMatchObject({ code: 'aborted' })

    expect(posted.some((body) => body.includes('RT1'))).toBe(true)
    expect(posted.some((body) => body.includes('RT2'))).toBe(false)
  })

  it('leaves a refresh started after the logout working normally', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: 'AT9', refresh_token: 'RT9', token_type: 'Bearer', expires_in: 3600 }),
    )
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    await client.setTokens(stored())
    await client.logout()

    // A fresh sign-in on the same client, then an ordinary refresh.
    await client.setTokens(stored({ accessToken: 'AT8', refreshToken: 'RT8' }))

    await expect(client.refresh()).resolves.toMatchObject({ accessToken: 'AT9' })
    expect(await client.isAuthenticated()).toBe(true)
  })
})

describe('store.logout() fences a login that started before it', () => {
  it('does not let the completed login sign the UI back in', async () => {
    const storage = memoryStorage()
    const release = deferred<void>()
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: 'AT1', refresh_token: 'RT1', token_type: 'Bearer', expires_in: 3600 }),
    )
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    const store = createAuthStore({ client, receiver: gatedReceiver(release.promise) })

    const loggingIn = store.login()
    await vi.waitFor(() => expect(store.getState().isLoading).toBe(true))

    await store.logout()
    expect(store.getState().isAuthenticated).toBe(false)

    // The callback arrives after the user signed out.
    release.resolve()
    await expect(loggingIn).resolves.toBeUndefined()

    expect(store.getState().isAuthenticated).toBe(false)
    expect(store.getState().tokens).toBeUndefined()
    expect(fetchImpl, 'the code must not be exchanged after a sign-out').not.toHaveBeenCalled()
    expect(await client.isAuthenticated()).toBe(false)
  })

  it('leaves a login started after the logout working normally', async () => {
    const storage = memoryStorage()
    const release = deferred<void>()
    release.resolve()
    const client = createAuthClient({
      provider,
      storage,
      fetch: async () =>
        tokenResponse({ access_token: 'AT1', refresh_token: 'RT1', token_type: 'Bearer', expires_in: 3600 }),
    })
    const store = createAuthStore({ client, receiver: gatedReceiver(release.promise) })

    await store.logout()
    await expect(store.login()).resolves.toMatchObject({ accessToken: 'AT1' })
    expect(store.getState().isAuthenticated).toBe(true)
  })
})

describe('logout() clears credentials under a previous provider id', () => {
  const renamed = defineProvider({
    id: 'demo',
    label: 'Demo',
    clientId: 'demo-client',
    authorizationUrl: 'https://provider.invalid/authorize',
    tokenUrl: 'https://provider.invalid/token',
    scopes: [],
    redirect: { mode: 'custom' },
    previousIds: ['legacy-demo'],
  })

  it('deletes the key a rename left behind', async () => {
    const storage = memoryStorage()
    await storage.set('tokens:legacy-demo', JSON.stringify(stored()))

    // The CLI's non-revoke logout never reads first, so nothing has migrated
    // the record onto the current key by the time it runs.
    const client = createAuthClient({ provider: renamed, storage })
    await client.logout()

    expect(await storage.keys?.()).toEqual([])
    expect(
      await createAuthClient({ provider: renamed, storage }).getTokens(),
      'the next read must not restore the session',
    ).toBeUndefined()
  })

  it('deletes it for the account it was scoped to', async () => {
    const storage = memoryStorage()
    await storage.set('tokens:legacy-demo:work', JSON.stringify(stored()))
    await storage.set('tokens:legacy-demo:home', JSON.stringify(stored()))

    await createAuthClient({ provider: renamed, storage, accountKey: 'work' }).logout()

    expect(await storage.keys?.()).toEqual(['tokens:legacy-demo:home'])
  })

  it('still signs the user out when the store refuses to delete that key', async () => {
    // A rejection here would land *after* the live credential was already
    // cleared, and `AuthStore.logout()` skips `setState({ tokens: undefined })`
    // on one: the UI would show the user signed in after a sign-out that did
    // take their token away.
    const backing = memoryStorage()
    const storage: AuthStorage = {
      ...backing,
      async delete(key) {
        if (key === 'tokens:legacy-demo') {
          throw new Error('this backend cannot delete a key it does not hold')
        }

        await backing.delete(key)
      },
    }
    const client = createAuthClient({ provider: renamed, storage })
    await client.setTokens(stored())

    await expect(client.logout()).resolves.toBeUndefined()
    expect(await storage.keys!()).toEqual([])
    expect(await client.getTokens()).toBeUndefined()
  })
})

describe('two clients sharing one store consume a pending record once', () => {
  it('exchanges the code exactly once', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: 'AT1', refresh_token: 'RT1', token_type: 'Bearer', expires_in: 3600 }),
    )
    // The shape a browser page has: one sessionStorage adapter, a fresh client
    // per loginWithPopup() call.
    const first = createAuthClient({ provider, storage, fetch: fetchImpl, redirectUri: 'http://127.0.0.1:9999/cb' })
    const second = createAuthClient({ provider, storage, fetch: fetchImpl, redirectUri: 'http://127.0.0.1:9999/cb' })

    const { state } = await first.createAuthorization()
    const results = await Promise.allSettled([
      first.completeAuthorization({ code: 'CODE', state }),
      second.completeAuthorization({ code: 'CODE', state }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      code: 'unknown_state',
    })
    expect(fetchImpl, 'a reused code costs the user every token minted from it').toHaveBeenCalledTimes(1)
  })
})

describe('refresh() re-reads storage after the provider refuses', () => {
  it('adopts a usable token another process wrote while the request was on the wire', async () => {
    const storage = memoryStorage()
    const newer = stored({ accessToken: 'AT2', refreshToken: 'RT2' })
    const fetchImpl = vi.fn(async () => {
      // Another CLI window rotated the credential while we were posting ours,
      // which is what made the provider refuse it.
      await storage.set('tokens:demo', JSON.stringify(newer))

      return tokenResponse({ error: 'invalid_grant' }, 400)
    })
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    await client.setTokens(stored())

    await expect(client.refresh()).resolves.toMatchObject({ accessToken: 'AT2' })
    expect(await client.getTokens()).toMatchObject({ accessToken: 'AT2' })
  })

  it('still fails when the store holds nothing better', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => tokenResponse({ error: 'invalid_grant' }, 400))
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    await client.setTokens(stored())

    await expect(client.refresh()).rejects.toMatchObject({ code: 'refresh_failed' })
  })

  it('does not adopt an expired token', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () => {
      await storage.set(
        'tokens:demo',
        JSON.stringify(stored({ accessToken: 'AT2', expiresAt: Date.now() - 1000 })),
      )

      return tokenResponse({ error: 'invalid_grant' }, 400)
    })
    const client = createAuthClient({ provider, storage, fetch: fetchImpl })
    await client.setTokens(stored())

    await expect(client.refresh()).rejects.toMatchObject({ code: 'refresh_failed' })
  })
})

describe('an abandoned login leaves no PKCE verifier at rest', () => {
  const pendingKeys = async (storage: AuthStorage) =>
    (await storage.keys!()).filter((key) => key.startsWith('pending:'))

  it('drops the pending record when the login times out', async () => {
    const storage = memoryStorage()
    const client = createAuthClient({ provider, storage })

    await expect(
      client.login({ receiver: gatedReceiver(new Promise<void>(() => {})), timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' })

    expect(await pendingKeys(storage)).toEqual([])
  })

  it('drops it when the callback fails the state check', async () => {
    const storage = memoryStorage()
    const client = createAuthClient({ provider, storage })
    const forged: CallbackReceiver = {
      id: 'forged',
      async start() {
        return {
          redirectUri: 'http://127.0.0.1:9999/cb',
          async present() {},
          async wait() {
            return { code: 'INJECTED', state: 'not-ours' }
          },
          async close() {},
        }
      },
    }

    await expect(client.login({ receiver: forged })).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(await pendingKeys(storage)).toEqual([])
  })

  it('drops it when the login is aborted', async () => {
    const storage = memoryStorage()
    const client = createAuthClient({ provider, storage })
    const controller = new AbortController()

    const loggingIn = client.login({
      receiver: gatedReceiver(new Promise<void>(() => {})),
      signal: controller.signal,
    })
    await vi.waitFor(async () => expect(await pendingKeys(storage)).toHaveLength(1))
    controller.abort()

    await expect(loggingIn).rejects.toMatchObject({ code: 'aborted' })
    expect(await pendingKeys(storage)).toEqual([])
  })
})

describe('a login with no state to attribute a callback to is bounded', () => {
  /** OpenRouter's shape: no `state` sent, none echoed back. */
  const stateless = defineProvider({
    ...provider,
    id: 'stateless',
    echoesState: false,
    buildAuthParams: (params) => ({ callback_url: params['redirect_uri'] ?? '' }),
  })
  /** The other half of the same shape: nothing in the URL to compare against. */
  const noStateSent = defineProvider({
    ...provider,
    id: 'no-state-sent',
    buildAuthParams: (params) => ({ callback_url: params['redirect_uri'] ?? '' }),
  })

  /**
   * A receiver whose `wait()` is never answered — what the popup and deep-link
   * receivers now leave behind when they drop a failure payload they cannot
   * attribute, which for these providers is every failure payload.
   */
  const never = () => gatedReceiver(new Promise<void>(() => {}))

  for (const candidate of [stateless, noStateSent]) {
    it(`terminates without a timeoutMs for "${candidate.id}"`, async () => {
      const storage = memoryStorage()
      // The deadline is the pending record's TTL — ten minutes in production,
      // shortened here so the test does not have to wait out a real one.
      const client = createAuthClient({ provider: candidate, storage, stateTtlMs: 50 })

      await expect(client.login({ receiver: never() })).rejects.toMatchObject({ code: 'timeout' })
      expect(
        await storage.keys!(),
        'the PKCE verifier must not be left at rest by a login that gave up',
      ).toEqual([])
    })
  }

  it('leaves a provider that echoes state waiting as long as the caller does', async () => {
    // The bound is for flows with nothing to attribute a denial against; one
    // that echoes `state` fails fast on a real denial and must keep waiting
    // for a user who is simply slow.
    const storage = memoryStorage()
    const client = createAuthClient({ provider, storage, stateTtlMs: 50 })
    const loggingIn = client.login({ receiver: never() })
    loggingIn.catch(() => {})

    const outcome = await Promise.race([
      loggingIn.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 250)),
    ])
    expect(outcome).toBe('waiting')
  })

  it('still completes the callback such a provider does send', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: 'AT1', token_type: 'Bearer' }),
    )
    const client = createAuthClient({ provider: stateless, storage, fetch: fetchImpl, stateTtlMs: 50 })
    const release = deferred<void>()
    const loggingIn = client.login({ receiver: gatedReceiver(release.promise) })
    release.resolve()

    await expect(loggingIn).resolves.toMatchObject({ accessToken: 'AT1' })
  })
})
