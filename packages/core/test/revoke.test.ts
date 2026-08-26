import { describe, expect, it } from 'vitest'

import { isOAuthError } from '../src/errors.js'
import { defineProvider } from '../src/providers/index.js'
import { revokeToken } from '../src/revoke.js'
import type { FetchLike, TokenSet } from '../src/types.js'

const provider = defineProvider({
  id: 'revoker',
  label: 'Revoker',
  clientId: 'revoker-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  revocationUrl: 'https://provider.test/revoke',
  scopes: [],
  redirect: { mode: 'custom' },
})

const tokens: TokenSet = {
  accessToken: 'at',
  refreshToken: 'rt',
  tokenType: 'Bearer',
  provider: 'revoker',
  raw: {},
}

/** A revocation endpoint that answers with one fixed status and body. */
const responding = (status: number, body = '', contentType = 'application/json'): FetchLike =>
  async () => new Response(body, { status, headers: { 'Content-Type': contentType } })

const revoke = (fetchImpl: FetchLike): Promise<void> =>
  revokeToken({ provider, clientId: 'revoker-client', tokens, fetchImpl })

/**
 * RFC 7009 §2.2 makes 200 the answer for a token that was revoked *and* for one
 * the server does not recognise, and §2.2.1's 400 codes all mean the revocation
 * did not happen — `unsupported_token_type` most plainly, since it says the
 * credential is still live. Accepting every 400 therefore reported an unrevoked
 * session as revoked.
 *
 * Rejecting every 400 is wrong in the other direction, and not hypothetically:
 * Google's endpoint, which `providers/gemini.ts` declares, answers
 * `400 {"error": "invalid_token"}` for a token it has already forgotten — the
 * exact case the RFC calls a success. So the body decides.
 */
describe('revokeToken', () => {
  it('resolves on 200', async () => {
    await expect(revoke(responding(200))).resolves.toBeUndefined()
  })

  it('resolves on the 400 invalid_token that Google sends for an unknown token', async () => {
    await expect(
      revoke(responding(400, JSON.stringify({ error: 'invalid_token' }))),
    ).resolves.toBeUndefined()
  })

  it('resolves on a 400 whose body says nothing we can read', async () => {
    await expect(revoke(responding(400, '<html>go away</html>', 'text/html'))).resolves.toBeUndefined()
    await expect(revoke(responding(400, ''))).resolves.toBeUndefined()
    await expect(revoke(responding(400, '{'))).resolves.toBeUndefined()
    await expect(revoke(responding(400, JSON.stringify({})))).resolves.toBeUndefined()
  })

  it('throws on unsupported_token_type, which leaves the token live', async () => {
    const error = await revoke(
      responding(400, JSON.stringify({ error: 'unsupported_token_type' })),
    ).catch((caught: unknown) => caught)

    expect(isOAuthError(error) && error.code).toBe('token_request_failed')
    expect(isOAuthError(error) && error.status).toBe(400)
  })

  it.each(['invalid_client', 'unauthorized_client', 'invalid_request'])(
    'throws on a 400 %s',
    async (code) => {
      const error = await revoke(responding(400, JSON.stringify({ error: code }))).catch(
        (caught: unknown) => caught,
      )

      expect(isOAuthError(error) && error.code).toBe('token_request_failed')
    },
  )

  it('still throws on other failure statuses', async () => {
    for (const status of [401, 403, 500, 503]) {
      const error = await revoke(responding(status)).catch((caught: unknown) => caught)
      expect(isOAuthError(error) && error.code, `HTTP ${status}`).toBe('token_request_failed')
    }
  })

  it('refuses a provider with no revocation endpoint', async () => {
    const noRevocation = defineProvider({
      id: 'no-revoke',
      label: 'No Revoke',
      clientId: 'c',
      authorizationUrl: 'https://provider.test/authorize',
      tokenUrl: 'https://provider.test/token',
      scopes: [],
      redirect: { mode: 'custom' },
    })

    const error = await revokeToken({
      provider: noRevocation,
      clientId: 'c',
      tokens,
      fetchImpl: responding(200),
    }).catch((caught: unknown) => caught)

    expect(isOAuthError(error) && error.code).toBe('configuration_error')
  })
})
