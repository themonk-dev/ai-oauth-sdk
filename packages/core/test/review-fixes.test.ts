/**
 * Regressions for the issues found in the pre-release review.
 *
 * Each test fails against the code as it stood before the fix, so they document
 * the behaviour rather than merely exercising it.
 */
import { describe, expect, it, vi } from 'vitest'

import { buildAuthorizationUrl } from '../src/authorize.js'
import { createAuthClient } from '../src/client.js'
import { OAuthError } from '../src/errors.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import { defineProvider } from '../src/providers/define.js'
import { claude } from '../src/providers/claude.js'
import { openai } from '../src/providers/openai.js'
import { providerFromDiscovery, resolveProvider } from '../src/providers/index.js'
import { startDeviceAuthorization } from '../src/receivers/device.js'
import { AuthorizationRegistry } from '../src/registry.js'
import { fromSyncStorage, memoryStorage, prefixedStorage } from '../src/storage.js'
import type { CallbackReceiver, CallbackResult, FetchLike, TokenSet } from '../src/types.js'

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
    // On a controlled clock rather than a real one. `create` prunes as it goes,
    // so with a 1ms TTL and a real clock the earlier entries were already being
    // swept by the later `create` calls, and how many survived to the explicit
    // prune came down to how fast the loop happened to run.
    let now = 1_000
    const registry = new AuthorizationRegistry({
      storage: fromSyncStorage(backing),
      ttlMs: 1_000,
      now: () => now,
    })

    for (let i = 0; i < 5; i++) {
      await registry.create({
        state: `s${i}`,
        provider: 'demo',
        redirectUri: 'http://x/cb',
        codeVerifier: `verifier-${i}`,
      })
    }

    now += 1_001

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

describe('discovery stores the endpoint it validated, not the one it read', () => {
  const serving = (document: unknown): FetchLike => {
    return async () =>
      new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  }

  const discover = (document: unknown, input: Record<string, unknown> = {}) =>
    providerFromDiscovery(
      'https://idp.acme.example',
      {
        id: 'acme',
        label: 'Acme',
        clientId: 'acme-client',
        redirect: { mode: 'custom' },
        ...input,
      },
      serving(document),
    )

  it('keeps CR/LF out of the authorization URL that reaches the browser', async () => {
    // The premise: the URL parser strips CR, LF and TAB before parsing, so the
    // https check passes on a string that is not the one being stored.
    const hostile = 'https://evil.test/authorize\r\ncalc\r\n'
    expect(new URL(hostile).protocol, 'the validator is happy with this').toBe('https:')
    expect(new URL(hostile).href, 'but it did not read the same string').not.toBe(hostile)

    const provider = await discover({
      authorization_endpoint: hostile,
      token_endpoint: 'https://acme.test/token',
    })

    expect(provider.authorizationUrl).toBe('https://evil.test/authorizecalc')

    // Where it ends up: `appendQuery` copies everything before the first `?`
    // verbatim, and on Windows that string becomes part of a cmd.exe command
    // line, where a bare newline starts a second command.
    const url = buildAuthorizationUrl({
      provider,
      clientId: 'acme-client',
      redirectUri: 'myapp://auth/callback',
      state: 'st-1',
    })

    expect(url).not.toMatch(/[\r\n\t]/)
    expect(url.startsWith('https://evil.test/authorizecalc?')).toBe(true)
  })

  it('does the same for the token and device endpoints', async () => {
    const provider = await discover({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/to\tken',
      device_authorization_endpoint: 'https://acme.test/dev\r\nice',
    })

    expect(provider.tokenUrl).toBe('https://acme.test/token')
    expect(provider.deviceAuthorizationUrl).toBe('https://acme.test/device')
  })

  it('leaves an endpoint the integrator passed exactly as they wrote it', async () => {
    // Their own config, not a remote party's — so it is neither checked nor
    // normalised, which is the line the `input.x == null` guards already drew.
    // The document-sourced value beside it shows the normalisation happening.
    const provider = await discover(
      { authorization_endpoint: 'https://acme.test', token_endpoint: 'https://acme.test/token' },
      { tokenUrl: 'http://internal-gateway.acme.test' },
    )

    expect(provider.tokenUrl).toBe('http://internal-gateway.acme.test')
    expect(provider.authorizationUrl).toBe('https://acme.test/')
  })

  it('ignores a scopes_supported that is not an array of strings', async () => {
    // A string here used to reach `provider.scopes` intact and die much later
    // as `scopes.join is not a function`; an object silently omitted `scope=`.
    for (const scopesSupported of ['openid email', {}, [1, 2], 42, true]) {
      const provider = await discover({
        authorization_endpoint: 'https://acme.test/authorize',
        token_endpoint: 'https://acme.test/token',
        scopes_supported: scopesSupported,
      })

      expect(provider.scopes).toEqual(['openid'])
      expect(() =>
        buildAuthorizationUrl({
          provider,
          clientId: 'acme-client',
          redirectUri: 'myapp://auth/callback',
          state: 'st-1',
        }),
      ).not.toThrow()
    }
  })

  it('still takes the scope list a well-formed document advertises', async () => {
    // The policy is unchanged: only the type of the value was ever in question.
    const provider = await discover({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
      scopes_supported: ['openid', 'email'],
    })

    expect(provider.scopes).toEqual(['openid', 'email'])
  })
})

describe('resolveProvider treats an absent override as no opinion', () => {
  it('keeps the built-in scopes when the caller passes undefined', () => {
    // The shape the docs teach, with an optional config key left unset:
    // `resolveProvider('claude', { scopes: config.scopes })`.
    const config: { scopes?: string[]; tokenUrl?: string } = {}
    const resolved = resolveProvider('claude', {
      scopes: config.scopes,
      tokenUrl: config.tokenUrl,
    })

    expect(resolved.scopes).toEqual(claude.scopes)
    expect(resolved.tokenUrl).toBe(claude.tokenUrl)
    // The failure this produced was a TypeError from `scopes.join`, one call
    // later and with nothing pointing back to here.
    expect(() =>
      buildAuthorizationUrl({
        provider: resolved,
        clientId: 'c',
        redirectUri: 'myapp://auth/callback',
        state: 'st-1',
      }),
    ).not.toThrow()
  })

  it('applies the same rule inside redirect, extraAuthParams and tokenRequest', () => {
    const resolved = resolveProvider('openai', {
      redirect: { mode: 'loopback', loopbackPort: undefined },
      extraAuthParams: { codex_cli_simplified_flow: undefined as unknown as string },
      tokenRequest: { style: 'form', includeClientIdInBody: undefined },
    })

    expect(resolved.redirect.loopbackPort).toBe(openai.redirect.loopbackPort)
    expect(resolved.extraAuthParams?.['codex_cli_simplified_flow']).toBe('true')
    expect(resolved.tokenRequest.includeClientIdInBody).toBe(true)
  })

  it('still lets a real value override', () => {
    const resolved = resolveProvider('claude', { scopes: ['mine'], tokenUrl: 'https://x.test/t' })

    expect(resolved.scopes).toEqual(['mine'])
    expect(resolved.tokenUrl).toBe('https://x.test/t')
    // An empty array is a value, not an absence: some providers want no scopes.
    expect(resolveProvider('claude', { scopes: [] }).scopes).toEqual([])
  })
})

describe('resolveProvider refuses a name it inherited rather than declared', () => {
  it('treats prototype keys exactly like any other unknown provider', () => {
    // A provider id arrives from config files, CLI flags and URL segments, so
    // it is not necessarily a name this library chose. A bare index read on the
    // registry walks `Object.prototype`, and every one of these came back
    // truthy — yielding a descriptor with `id: undefined`.
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(() => resolveProvider(name), name).toThrowError(OAuthError)
      expect(() => resolveProvider(name), name).toThrowError(/Unknown provider/)
    }

    expect(() => resolveProvider('nope')).toThrowError(/Unknown provider/)
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
