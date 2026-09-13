/**
 * The token endpoint's response is JSON from someone else's server, and
 * `TokenEndpointResponse` describes what RFC 6749 §5.1 asks for rather than
 * what arrives. Every test here feeds `exchangeCode`/`refreshTokens` a body
 * that type-checks as far as TypeScript is concerned and is not what it claims
 * to be, and asserts that nothing unusable reaches the stored credential.
 *
 * Each fails against the code as it stood before the fix.
 */
import { describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import { OAuthError } from '../src/errors.js'
import { defineProvider } from '../src/providers/define.js'
import { memoryStorage } from '../src/storage.js'
import { exchangeCode, refreshTokens } from '../src/token.js'
import type { TokenSet } from '../src/types.js'

const provider = defineProvider({
  id: 'demo',
  label: 'Demo',
  clientId: 'demo-client',
  authorizationUrl: 'https://provider.invalid/authorize',
  tokenUrl: 'https://provider.invalid/token',
  scopes: [],
  redirect: { mode: 'custom' },
})

/** A token endpoint that answers every request with `body`, verbatim. */
const serving = (body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const exchange = (body: unknown): Promise<TokenSet> =>
  exchangeCode({
    provider,
    clientId: 'demo-client',
    code: 'CODE',
    redirectUri: 'https://app.invalid/callback',
    fetchImpl: serving(body),
  })

describe('token_type is only kept when it can carry the credential', () => {
  it('falls back to Bearer when the provider sends an object', async () => {
    const tokens = await exchange({ access_token: 'AT', token_type: { scheme: 'Bearer' } })

    // Was `[object Object] AT` once it reached the Authorization header.
    expect(tokens.tokenType).toBe('Bearer')
  })

  it('falls back to Bearer when the provider sends a number', async () => {
    const tokens = await exchange({ access_token: 'AT', token_type: 7 })

    expect(tokens.tokenType).toBe('Bearer')
  })

  it('falls back to Bearer on an empty string rather than leading with a space', async () => {
    const tokens = await exchange({ access_token: 'AT', token_type: '' })

    expect(tokens.tokenType).toBe('Bearer')
  })

  it('refuses a value carrying CRLF instead of letting fetch throw a TypeError', async () => {
    const tokens = await exchange({
      access_token: 'AT',
      token_type: 'Bearer\r\nX-Injected: 1',
    })

    expect(tokens.tokenType).toBe('Bearer')
    // The point of the fallback: `Headers.set` rejects CR/LF outright, so the
    // unusable value would otherwise surface as a TypeError thrown from inside
    // `fetch` on the first API call.
    expect(() => new Headers().set('Authorization', `${tokens.tokenType} AT`)).not.toThrow()
  })

  it('trims surrounding whitespace instead of discarding the scheme', async () => {
    const tokens = await exchange({ access_token: 'AT', token_type: '  DPoP  ' })

    expect(tokens.tokenType).toBe('DPoP')
  })

  it('keeps a non-Bearer scheme the provider really does use', async () => {
    const tokens = await exchange({ access_token: 'AT', token_type: 'DPoP' })

    expect(tokens.tokenType).toBe('DPoP')
  })

  it('sends a usable Authorization header for an object token_type', async () => {
    const client = createAuthClient({
      provider,
      storage: memoryStorage(),
      fetch: serving({ access_token: 'AT', token_type: { scheme: 'Bearer' } }),
    })
    await client.setTokens(await exchange({ access_token: 'AT', token_type: { scheme: 'Bearer' } }))

    let seen: string | null = null
    const authed = createAuthenticatedFetch(client, {
      fetch: async (_input, init) => {
        seen = new Headers(init?.headers).get('Authorization')

        return new Response('{}', { status: 200 })
      },
    })
    await authed('https://api.invalid/v1/models')

    expect(seen).toBe('Bearer AT')
  })
})

describe('id_token is only kept when it is a string', () => {
  it('drops a non-string rather than passing it to the JWT decoder', async () => {
    const tokens = await exchange({ access_token: 'AT', id_token: { sub: 'user-1' } })

    expect(tokens.idToken).toBeUndefined()
  })

  it('completes the exchange for a provider that decodes id_token claims', async () => {
    const decoding = defineProvider({
      ...provider,
      id: 'decodes-identity',
      // The shape openai/gemini/xai use: `decodeJwtPayload` is reached through
      // `tokens.idToken`, and its `split('.')` sits above its own `try`.
      enrichTokens: (_raw, tokens) => ({ accountId: tokens.idToken?.split('.')[0] ?? 'anon' }),
    })

    const tokens = await exchangeCode({
      provider: decoding,
      clientId: 'demo-client',
      code: 'CODE',
      redirectUri: 'https://app.invalid/callback',
      fetchImpl: serving({ access_token: 'AT', id_token: 12345 }),
    })

    // Threw `TypeError: tokens.idToken.split is not a function` before the fix.
    expect(tokens.accountId).toBe('anon')
  })
})

describe('scope is only kept when it is a string', () => {
  it('drops an array rather than storing it as the scope', async () => {
    const tokens = await exchange({ access_token: 'AT', scope: ['openid', 'email'] })

    expect(tokens.scope).toBeUndefined()
  })
})

describe('refresh_token is validated before the stored one is given up', () => {
  const stored: TokenSet = {
    accessToken: 'STALE',
    refreshToken: 'STORED_RT',
    tokenType: 'Bearer',
    provider: 'demo',
    expiresAt: Date.now() - 1000,
    raw: {},
  }

  it('keeps the stored token when a renewal answers with an empty string', async () => {
    const renewed = await refreshTokens({
      provider,
      clientId: 'demo-client',
      tokens: stored,
      fetchImpl: serving({ access_token: 'FRESH', refresh_token: '' }),
    })

    // `'' ?? 'STORED_RT'` is `''`, which is falsy — so the whole carry-forward
    // was skipped and the session became unrenewable.
    expect(renewed.refreshToken).toBe('STORED_RT')
  })

  it('keeps the stored token when a renewal answers with a non-string', async () => {
    const renewed = await refreshTokens({
      provider,
      clientId: 'demo-client',
      tokens: stored,
      fetchImpl: serving({ access_token: 'FRESH', refresh_token: { value: 'RT' } }),
    })

    expect(renewed.refreshToken).toBe('STORED_RT')
  })

  it('still rotates to a real new refresh token', async () => {
    const renewed = await refreshTokens({
      provider,
      clientId: 'demo-client',
      tokens: stored,
      fetchImpl: serving({ access_token: 'FRESH', refresh_token: 'ROTATED_RT' }),
    })

    expect(renewed.refreshToken).toBe('ROTATED_RT')
  })

  it('leaves a session renewable after an empty-string renewal is persisted', async () => {
    const client = createAuthClient({
      provider,
      storage: memoryStorage(),
      fetch: serving({ access_token: 'FRESH', refresh_token: '', expires_in: 3600 }),
    })
    await client.setTokens(stored)
    await client.refresh()

    expect((await client.getTokens())?.refreshToken).toBe('STORED_RT')
  })
})

describe('access_token is still required to be a usable string', () => {
  it('rejects a non-string access_token', async () => {
    await expect(exchange({ access_token: { value: 'AT' } })).rejects.toThrow(OAuthError)
  })
})
