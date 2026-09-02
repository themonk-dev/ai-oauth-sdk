import { describe, expect, it } from 'vitest'

import { defineProvider } from '../src/providers/define.js'
import { exchangeCode, isExpired, refreshTokens } from '../src/token.js'
import type { TokenSet } from '../src/types.js'

const provider = defineProvider({
  id: 'shape-test',
  label: 'Shape Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  redirect: { mode: 'loopback' },
})

/** Answers every token request with `body`, verbatim. */
const respondWith = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

const stored = (overrides: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'old-access',
  refreshToken: 'stored-refresh-token',
  tokenType: 'Bearer',
  provider: provider.id,
  raw: {},
  ...overrides,
})

const refreshWith = (body: unknown, previous = stored()) =>
  refreshTokens({ provider, clientId: 'c', tokens: previous, fetchImpl: respondWith(body) })

const exchangeWith = (body: unknown) =>
  exchangeCode({
    provider,
    clientId: 'c',
    code: 'x',
    redirectUri: 'http://localhost/cb',
    fetchImpl: respondWith(body),
  })

describe('refresh_token is validated before it is chosen', () => {
  // A gateway that always emits the field sends `""` on a renewal. Testing the
  // whole `??` expression for truthiness made that falsy, so the key was left
  // off and the stored token went with it — and the *next* refresh failed with
  // `refresh_failed` for a session that was still perfectly renewable.
  it('keeps the stored refresh token when the response sends an empty string', async () => {
    const tokens = await refreshWith({ access_token: 'new-access', refresh_token: '' })

    expect(tokens.accessToken).toBe('new-access')
    expect(tokens.refreshToken).toBe('stored-refresh-token')
  })

  it('keeps the stored refresh token when the response omits it entirely', async () => {
    const tokens = await refreshWith({ access_token: 'new-access' })
    expect(tokens.refreshToken).toBe('stored-refresh-token')
  })

  it('keeps the stored refresh token when the response sends null', async () => {
    const tokens = await refreshWith({ access_token: 'new-access', refresh_token: null })
    expect(tokens.refreshToken).toBe('stored-refresh-token')
  })

  it('keeps the stored refresh token when the response sends 0', async () => {
    const tokens = await refreshWith({ access_token: 'new-access', refresh_token: 0 })
    expect(tokens.refreshToken).toBe('stored-refresh-token')
  })

  // `access_token` gets a hard type check; a non-string here used to be carried
  // through unvalidated and would go straight into the next request body.
  it('rejects a non-string refresh token rather than carrying it through', async () => {
    const tokens = await refreshWith({ access_token: 'new-access', refresh_token: 12345 })

    expect(tokens.refreshToken).toBe('stored-refresh-token')
    expect(typeof tokens.refreshToken).toBe('string')
  })

  it('still rotates to a real new refresh token', async () => {
    const tokens = await refreshWith({ access_token: 'new-access', refresh_token: 'rotated' })
    expect(tokens.refreshToken).toBe('rotated')
  })

  it('leaves it unset when there is nothing to carry forward', async () => {
    const tokens = await exchangeWith({ access_token: 'at', refresh_token: '' })
    expect(tokens.refreshToken).toBeUndefined()
  })
})

describe('expires_in is coerced before it is used', () => {
  // No `expiresAt` means `isExpired` answers false forever, so the credential
  // is never renewed ahead of its real expiry and a caller driving its own HTTP
  // client with `authorizationHeader()` gets permanent 401s.
  it('accepts the digits as a JSON string, which providers do send', async () => {
    const before = Date.now()
    const tokens = await exchangeWith({ access_token: 'at', expires_in: '3600' })

    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
  })

  it('lets a string lifetime drive renewal, which no expiry at all cannot', async () => {
    const tokens = await exchangeWith({ access_token: 'at', expires_in: '1' })

    // One second out is well inside the renewal skew window, so this token is
    // due for renewal now. Without an `expiresAt`, `isExpired` answers false
    // and nothing ever renews it.
    expect(isExpired(tokens)).toBe(true)
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('still accepts a plain number', async () => {
    const before = Date.now()
    const tokens = await exchangeWith({ access_token: 'at', expires_in: 60 })

    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
  })

  it.each([
    ['junk', 'soon'],
    ['an empty string', ''],
    ['null', null],
    ['a negative lifetime', -1],
    ['Infinity, which JSON sends as a string', 'Infinity'],
    ['an object', { seconds: 60 }],
    // `Number` is looser than the check below it reads: each of these coerces
    // to a clean 0, which is not "no lifetime" but "expired at Date.now()" —
    // `isExpired` then answers true forever and every `getAccessToken()` burns
    // a refresh on a credential that was never given a lifetime at all.
    ['an empty array, which coerces to 0', []],
    ['a whitespace string, which coerces to 0', '  '],
    ['a newline, which coerces to 0', '\n'],
    ['false, which coerces to 0', false],
    // And this one coerces to 1, i.e. a token that expires in a second.
    ['true, which coerces to 1', true],
  ])('drops %s rather than inventing an expiry', async (_label, value) => {
    const tokens = await exchangeWith({ access_token: 'at', expires_in: value })
    expect(tokens.expiresAt).toBeUndefined()
  })

  // The coercing values above are worse than a missing expiry, not equal to it:
  // they read as *already expired*, so nothing the client hands out is ever
  // considered usable.
  it.each([
    ['an empty array', []],
    ['a whitespace string', '  '],
    ['false', false],
  ])('does not report a token as expired because %s coerced to 0', async (_label, value) => {
    const tokens = await exchangeWith({ access_token: 'at', expires_in: value })
    expect(isExpired(tokens)).toBe(false)
  })

  it('still treats a real 0 as a lifetime of zero', async () => {
    const tokens = await exchangeWith({ access_token: 'at', expires_in: 0 })

    expect(tokens.expiresAt).toBeDefined()
    expect(isExpired(tokens)).toBe(true)
  })

  it('leaves expiresAt unset when the provider states no lifetime', async () => {
    const tokens = await exchangeWith({ access_token: 'at' })
    expect(tokens.expiresAt).toBeUndefined()
  })
})
