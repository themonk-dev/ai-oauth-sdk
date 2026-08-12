import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { isOAuthError, OAuthError } from '../src/errors.js'
import { defineProvider } from '../src/providers/define.js'
import { providers, publicClientIds } from '../src/providers/index.js'
import { memoryStorage } from '../src/storage.js'
import type { CallbackReceiver, ProviderConfig } from '../src/types.js'
import { startFakeAuthServer, type FakeAuthServer } from './helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    scopes: ['openid', 'profile'],
    redirect: { mode: 'loopback', loopbackPort: 0 },
    ...overrides,
  })

/** Drives the fake server's authorize endpoint the way a browser would. */
async function followAuthorization(authorizationUrl: string): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = response.headers.get('location')!
  const params = new URL(location).searchParams

  return { code: params.get('code')!, state: params.get('state')! }
}

beforeEach(async () => {
  server = await startFakeAuthServer()
})

afterEach(async () => {
  await server.close()
  vi.useRealTimers()
})

describe('authorization lifecycle', () => {
  it('completes a full PKCE flow and stores the tokens', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })

    const authorization = await client.createAuthorization()
    expect(authorization.state).toHaveLength(43)
    expect(authorization.codeVerifier).toHaveLength(43)

    const { code, state } = await followAuthorization(authorization.url)
    expect(state).toBe(authorization.state)

    const tokens = await client.completeAuthorization({ code, state })
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.provider).toBe('test')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())

    // The server independently verified the PKCE challenge, so reaching here
    // proves verifier/challenge derivation matches a real implementation.
    expect(server.requests[0]?.['code_verifier']).toBe(authorization.codeVerifier)
    expect(await client.getTokens()).toMatchObject({ accessToken: 'access-1' })
  })

  it('rejects a state it never issued', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    await expect(
      client.completeAuthorization({ code: 'x', state: 'never-issued' }),
    ).rejects.toMatchObject({ code: 'unknown_state' })
  })

  it('refuses to reuse a state twice', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    await client.completeAuthorization({ code, state })
    // Replaying the same state must not replay the exchange.
    await expect(client.completeAuthorization({ code, state })).rejects.toMatchObject({
      code: 'unknown_state',
    })
  })

  it('expires a pending authorization after its TTL', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
      stateTtlMs: 50,
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    await new Promise((resolve) => setTimeout(resolve, 80))
    await expect(client.completeAuthorization({ code, state })).rejects.toMatchObject({
      code: 'state_expired',
    })
  })

  it('accepts a raw callback URL instead of code/state', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    const tokens = await client.completeAuthorization({
      callbackUrl: `http://localhost:9999/callback?code=${code}&state=${state}`,
    })
    expect(tokens.accessToken).toBe('access-1')
  })

  it('surfaces a denial from the callback URL', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    await expect(
      client.completeAuthorization({
        callbackUrl: 'http://localhost:9999/callback?error=access_denied&error_description=nope',
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied', providerError: 'access_denied' })
  })

  it('round-trips caller metadata on the pending record', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization({ metadata: { userId: 'u-42' } })
    const pending = await client.getPendingAuthorization(authorization.state)
    expect(pending?.metadata).toEqual({ userId: 'u-42' })
  })
})

describe('pending authorizations are bound to their provider', () => {
  it('refuses a callback that belongs to another provider, without contacting the token endpoint', async () => {
    /* Two providers, two authorization servers, one storage — the ordinary
       shape of an app that offers a choice of logins. */
    const serverB = await startFakeAuthServer()

    try {
      const storage = memoryStorage()
      const clientA = createAuthClient({
        provider: testProvider(server.url, { id: 'provider-a' }),
        redirectUri: 'http://localhost:9999/callback-a',
        storage,
      })
      const clientB = createAuthClient({
        provider: testProvider(serverB.url, { id: 'provider-b' }),
        redirectUri: 'http://localhost:9999/callback-b',
        storage,
      })

      const authorization = await clientA.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)

      await expect(clientB.completeAuthorization({ code, state })).rejects.toMatchObject({
        code: 'state_mismatch',
      })

      // The security-relevant part: provider A's code, verifier and redirect
      // URI never reached provider B.
      expect(serverB.requests).toHaveLength(0)
      expect(server.requests).toHaveLength(0)
    } finally {
      await serverB.close()
    }
  })

  it('consumes the mis-routed record, so it cannot be replayed at the right client', async () => {
    const serverB = await startFakeAuthServer()

    try {
      const storage = memoryStorage()
      const clientA = createAuthClient({
        provider: testProvider(server.url, { id: 'provider-a' }),
        redirectUri: 'http://localhost:9999/callback-a',
        storage,
      })
      const clientB = createAuthClient({
        provider: testProvider(serverB.url, { id: 'provider-b' }),
        redirectUri: 'http://localhost:9999/callback-b',
        storage,
      })

      const authorization = await clientA.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)

      await expect(clientB.completeAuthorization({ code, state })).rejects.toMatchObject({
        code: 'state_mismatch',
      })
      await expect(clientA.completeAuthorization({ code, state })).rejects.toMatchObject({
        code: 'unknown_state',
      })
    } finally {
      await serverB.close()
    }
  })

  it('still completes a flow started under an id the provider has since shed', async () => {
    /* The upgrade case: the pending record was written by the version that
       still called this provider `legacy-test`. */
    const storage = memoryStorage()
    const before = createAuthClient({
      provider: testProvider(server.url, { id: 'legacy-test' }),
      redirectUri: 'http://localhost:9999/callback',
      storage,
    })
    const after = createAuthClient({
      provider: testProvider(server.url, { id: 'test', previousIds: ['legacy-test'] }),
      redirectUri: 'http://localhost:9999/callback',
      storage,
    })

    const authorization = await before.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)

    const tokens = await after.completeAuthorization({ code, state })
    expect(tokens.accessToken).toBe('access-1')
    expect(server.requests[0]?.['code_verifier']).toBe(authorization.codeVerifier)
  })
})

describe('waitForAuthorization — the state-keyed handoff', () => {
  it('delivers tokens to a waiter that started before the callback', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()

    // Start waiting first, complete later — the usual server-side shape.
    const waiting = client.waitForAuthorization(authorization.state)
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    await expect(waiting).resolves.toMatchObject({ accessToken: 'access-1' })
  })

  it('delivers tokens to a waiter that arrives after the callback', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    // The result was buffered, so there is no race to lose.
    await expect(client.waitForAuthorization(authorization.state)).resolves.toMatchObject({
      accessToken: 'access-1',
    })
  })

  it('serves several concurrent waiters on one state', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()

    const waiters = [
      client.waitForAuthorization(authorization.state),
      client.waitForAuthorization(authorization.state),
      client.waitForAuthorization(authorization.state),
    ]
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    for (const result of await Promise.all(waiters)) {
      expect(result.accessToken).toBe('access-1')
    }
  })

  it('propagates a failure to waiters', async () => {
    const failing = await startFakeAuthServer({ failWith: 'invalid_grant' })

    try {
      const client = createAuthClient({
        provider: testProvider(failing.url),
        redirectUri: 'http://localhost:9999/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const waiting = client.waitForAuthorization(authorization.state)
      const { code, state } = await followAuthorization(authorization.url)

      await expect(client.completeAuthorization({ code, state })).rejects.toThrow()
      await expect(waiting).rejects.toMatchObject({ code: 'token_request_failed' })
    } finally {
      await failing.close()
    }
  })

  it('honours a timeout', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    await expect(
      client.waitForAuthorization(authorization.state, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('honours an abort signal', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const controller = new AbortController()
    const waiting = client.waitForAuthorization(authorization.state, { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('token refresh', () => {
  it('refreshes automatically once the token is inside the skew window', async () => {
    const shortLived = await startFakeAuthServer({ expiresIn: 1 })

    try {
      const client = createAuthClient({
        provider: testProvider(shortLived.url),
        redirectUri: 'http://localhost:9999/callback',
        storage: memoryStorage(),
        /* A 1s lifetime is always inside a 60s skew. */
        expirySkewMs: 60_000,
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      await client.completeAuthorization({ code, state })

      expect(shortLived.refreshCount).toBe(0)
      const accessToken = await client.getAccessToken()
      expect(shortLived.refreshCount).toBe(1)
      expect(accessToken).toBe('access-2')
    } finally {
      await shortLived.close()
    }
  })

  it('does not refresh while the token is still fresh', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    expect(await client.getAccessToken()).toBe('access-1')
    expect(server.refreshCount).toBe(0)
  })

  it('collapses concurrent refreshes into a single request', async () => {
    const slow = await startFakeAuthServer({ expiresIn: 1, delayMs: 40 })

    try {
      const client = createAuthClient({
        provider: testProvider(slow.url),
        redirectUri: 'http://localhost:9999/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      await client.completeAuthorization({ code, state })

      // Ten callers wake to an expired token at once. Without deduping, a
      // provider that rotates refresh tokens would invalidate its own tokens.
      const tokens = await Promise.all(Array.from({ length: 10 }, () => client.getAccessToken()))
      expect(slow.refreshCount).toBe(1)
      expect(new Set(tokens).size).toBe(1)
    } finally {
      await slow.close()
    }
  })

  it('keeps the old refresh token when renewal omits one', async () => {
    const rotating = await startFakeAuthServer({ expiresIn: 1, omitRefreshOnRenew: true })

    try {
      const client = createAuthClient({
        provider: testProvider(rotating.url),
        redirectUri: 'http://localhost:9999/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      await client.completeAuthorization({ code, state })

      const refreshed = await client.refresh()
      // Losing this would make the *next* refresh impossible.
      expect(refreshed.refreshToken).toBe('refresh-1')
    } finally {
      await rotating.close()
    }
  })

  it('reports a missing refresh token clearly', async () => {
    const noRefresh = await startFakeAuthServer({ extraTokenFields: { refresh_token: undefined } })

    try {
      const client = createAuthClient({
        provider: testProvider(noRefresh.url),
        redirectUri: 'http://localhost:9999/callback',
        storage: memoryStorage(),
      })
      await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'refresh_failed' })
    } finally {
      await noRefresh.close()
    }
  })

  it('adopts a token another process already refreshed', async () => {
    const shortLived = await startFakeAuthServer({ expiresIn: 1 })

    try {
      // Two clients over one store, as two terminal windows would be.
      const storage = memoryStorage()
      const provider = testProvider(shortLived.url)
      const mine = createAuthClient({ provider, redirectUri: 'http://localhost:9999/callback', storage })
      const other = createAuthClient({ provider, redirectUri: 'http://localhost:9999/callback', storage })

      const authorization = await mine.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      await mine.completeAuthorization({ code, state })

      // My client caches the near-expired token.
      expect((await mine.getTokens())?.accessToken).toBe('access-1')

      // The other process refreshes and stores a long-lived token. My cached
      // copy is now stale, and with rotating refresh tokens mine is dead.
      await other.setTokens({
        ...(await other.getTokens())!,
        accessToken: 'refreshed-elsewhere',
        refreshToken: 'rotated',
        expiresAt: Date.now() + 3_600_000,
      })

      const token = await mine.getAccessToken()
      expect(token).toBe('refreshed-elsewhere')
      // Adopted rather than refreshed — no network call was needed.
      expect(shortLived.refreshCount).toBe(0)
    } finally {
      await shortLived.close()
    }
  })

  it('still refreshes when the stored token is also expired', async () => {
    const shortLived = await startFakeAuthServer({ expiresIn: 1 })

    try {
      const client = createAuthClient({
        provider: testProvider(shortLived.url),
        redirectUri: 'http://localhost:9999/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      await client.completeAuthorization({ code, state })

      // Nobody else refreshed, so re-reading finds the same dead token and the
      // refresh must go ahead.
      await client.getAccessToken()
      expect(shortLived.refreshCount).toBe(1)
    } finally {
      await shortLived.close()
    }
  })

  it('builds an Authorization header', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    expect(await client.authorizationHeader()).toBe('Bearer access-1')
  })
})

describe('token persistence', () => {
  it('shares tokens between clients over the same storage', async () => {
    const storage = memoryStorage()
    const provider = testProvider(server.url)

    const first = createAuthClient({ provider, redirectUri: 'http://localhost:9999/callback', storage })
    const authorization = await first.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await first.completeAuthorization({ code, state })

    // A fresh process reading the same store must find the session.
    const second = createAuthClient({ provider, redirectUri: 'http://localhost:9999/callback', storage })
    expect(await second.isAuthenticated()).toBe(true)
    expect(await second.getAccessToken()).toBe('access-1')
  })

  it('keeps accounts separate via accountKey', async () => {
    const storage = memoryStorage()
    const provider = testProvider(server.url)

    const work = createAuthClient({
      provider,
      redirectUri: 'http://localhost:9999/callback',
      storage,
      accountKey: 'work',
    })
    const personal = createAuthClient({
      provider,
      redirectUri: 'http://localhost:9999/callback',
      storage,
      accountKey: 'personal',
    })

    const authorization = await work.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await work.completeAuthorization({ code, state })

    expect(await work.isAuthenticated()).toBe(true)
    expect(await personal.isAuthenticated()).toBe(false)
  })

  it('clears tokens on logout', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url),
      redirectUri: 'http://localhost:9999/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    await client.logout()
    expect(await client.isAuthenticated()).toBe(false)
    expect(await client.getTokens()).toBeUndefined()
  })
})

describe('login() with a receiver', () => {
  /** A receiver that drives the fake authorization endpoint itself. */
  const scriptedReceiver = (redirectUri: string, mutateState?: (s: string) => string): CallbackReceiver => ({
    id: 'scripted',
    async start() {
      let result: Promise<{ code: string; state: string }> | undefined

      return {
        redirectUri,
        async present(url) {
          result = followAuthorization(url).then(({ code, state }) => ({
            code,
            state: mutateState ? mutateState(state) : state,
          }))
        },
        wait: () => result!,
        async close() {},
      }
    },
  })

  it('runs the whole flow', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    const tokens = await client.login({
      receiver: scriptedReceiver('http://localhost:9999/callback'),
    })
    expect(tokens.accessToken).toBe('access-1')
    expect(await client.isAuthenticated()).toBe(true)
  })

  it('rejects a mismatched state (CSRF guard)', async () => {
    const client = createAuthClient({ provider: testProvider(server.url), storage: memoryStorage() })
    await expect(
      client.login({ receiver: scriptedReceiver('http://localhost:9999/callback', () => 'tampered') }),
    ).rejects.toMatchObject({ code: 'state_mismatch' })
  })
})

describe('configuration errors', () => {
  it('demands a client id from every provider that needs one', () => {
    // The Passport model: nothing is silently defaulted, so a missing
    // credential is always an explicit error rather than a surprise identity.
    for (const id of Object.keys(providers)) {
      /* OpenRouter sends no client_id at all. */
      if (id === 'openrouter') {
        continue
      }


      expect(() => createAuthClient({ provider: id }), id).toThrowError(OAuthError)
    }
  })

  it('points at publicClientIds when the vendor publishes one', () => {
    try {
      createAuthClient({ provider: 'openai' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isOAuthError(error) && error.code).toBe('configuration_error')
      const message = (error as OAuthError).message
      expect(message).toMatch(/publicClientIds/)
      // The consequence of opting in has to be stated, not just the mechanism.
      expect(message).toMatch(/presents your app as that vendor/)
    }
  })

  // Every built-in now has a published id to point at, so the guidance is
  // about how to opt into one rather than where to go and register your own.
  it('names the published credential in the error', () => {
    try {
      createAuthClient({ provider: 'gemini' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as OAuthError).message).toMatch(/publicClientIds\['gemini'\]/)
    }

    try {
      createAuthClient({ provider: 'xai' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as OAuthError).message).toMatch(/publicClientIds\['xai'\]/)
    }
  })

  it('accepts a published id, or your own', () => {
    expect(() =>
      createAuthClient({ provider: 'openai', clientId: publicClientIds.openai }),
    ).not.toThrow()
    expect(() => createAuthClient({ provider: 'openai', clientId: 'mine' })).not.toThrow()
    expect(() => createAuthClient({ provider: 'xai', clientId: 'mine' })).not.toThrow()
    expect(() =>
      createAuthClient({ provider: 'gemini', clientId: 'mine', clientSecret: 'shh' }),
    ).not.toThrow()
  })

  it('needs no client id for a provider that sends none', () => {
    // OpenRouter identifies apps by callback URL; demanding one would be theatre.
    expect(() => createAuthClient({ provider: 'openrouter' })).not.toThrow()
  })

  it('explains a missing redirect URI', async () => {
    const client = createAuthClient({
      provider: testProvider(server.url, { redirect: { mode: 'custom' } }),
      storage: memoryStorage(),
    })
    await expect(client.createAuthorization()).rejects.toMatchObject({ code: 'configuration_error' })
  })
})

describe('provider-specific token handling', () => {
  it('pulls account identity out of an OpenAI id_token', async () => {
    const withIdToken = await startFakeAuthServer({
      idTokenClaims: {
        email: 'dev@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
      },
    })

    try {
      const client = createAuthClient({
        provider: {
          ...(await import('../src/providers/openai.js')).openai,
          clientId: publicClientIds.openai,
          tokenUrl: `${withIdToken.url}/token`,
          authorizationUrl: `${withIdToken.url}/authorize`,
        },
        redirectUri: 'http://localhost:1455/auth/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      const tokens = await client.completeAuthorization({ code, state })

      expect(tokens.accountId).toBe('acct-123')
      expect(tokens.email).toBe('dev@example.com')
    } finally {
      await withIdToken.close()
    }
  })

  it('falls back to the first organization id for org accounts', async () => {
    const orgAccount = await startFakeAuthServer({
      idTokenClaims: {
        email: 'team@example.com',
        'https://api.openai.com/auth': { organizations: [{ id: 'org-777' }, { id: 'org-888' }] },
      },
    })

    try {
      const { openai } = await import('../src/providers/openai.js')
      const client = createAuthClient({
        provider: {
          ...openai,
          clientId: publicClientIds.openai,
          tokenUrl: `${orgAccount.url}/token`,
          authorizationUrl: `${orgAccount.url}/authorize`,
        },
        redirectUri: 'http://localhost:1455/auth/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      const tokens = await client.completeAuthorization({ code, state })

      expect(tokens.accountId).toBe('org-777')
    } finally {
      await orgAccount.close()
    }
  })

  it('pulls account identity out of an Anthropic token response', async () => {
    const withAccount = await startFakeAuthServer({
      extraTokenFields: { account: { uuid: 'uuid-9', email_address: 'claude@example.com' } },
    })

    try {
      const { claude } = await import('../src/providers/claude.js')
      const client = createAuthClient({
        provider: {
          ...claude,
          clientId: publicClientIds.claude,
          tokenUrl: `${withAccount.url}/token`,
          authorizationUrl: `${withAccount.url}/authorize`,
        },
        redirectUri: 'https://platform.claude.com/oauth/code/callback',
        storage: memoryStorage(),
      })
      const authorization = await client.createAuthorization()
      const { code, state } = await followAuthorization(authorization.url)
      const tokens = await client.completeAuthorization({ code, state })

      expect(tokens.accountId).toBe('uuid-9')
      expect(tokens.email).toBe('claude@example.com')
    } finally {
      await withAccount.close()
    }
  })

  it('sends form encoding, which Anthropic requires', async () => {
    const { claude } = await import('../src/providers/claude.js')
    const client = createAuthClient({
      provider: {
        ...claude,
        clientId: publicClientIds.claude,
        tokenUrl: `${server.url}/token`,
        authorizationUrl: `${server.url}/authorize`,
      },
      redirectUri: 'https://platform.claude.com/oauth/code/callback',
      storage: memoryStorage(),
    })
    const authorization = await client.createAuthorization()
    const { code, state } = await followAuthorization(authorization.url)
    await client.completeAuthorization({ code, state })

    // The fake server parsed it as a form body; a JSON body would have failed.
    expect(server.requests[0]?.['grant_type']).toBe('authorization_code')
    expect(server.requests[0]?.['state']).toBe(authorization.state)
  })
})
