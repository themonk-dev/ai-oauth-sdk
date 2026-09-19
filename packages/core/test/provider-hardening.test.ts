import { describe, expect, it } from 'vitest'

import { OAuthError } from '../src/errors.js'
import { exchangeForCopilotToken } from '../src/providers/github-copilot.js'
import type { FetchLike, TokenSet } from '../src/types.js'

const tokens: TokenSet = {
  accessToken: 'ghu_github-token',
  tokenType: 'Bearer',
  provider: 'github-copilot',
  raw: {},
}

/** Stands in for the exchange endpoint, naming whatever host we hand it. */
function stubExchange(endpoints: unknown): FetchLike {
  return async () =>
    Response.json({
      token: 'copilot-token',
      expires_at: Math.floor((Date.now() + 1500 * 1000) / 1000),
      ...(endpoints === undefined ? {} : { endpoints }),
    })
}

/*
 * `endpoints.api` decides where every later request sends the Copilot token as
 * a bearer credential. It arrives over TLS from a hard-coded api.github.com, so
 * this is the same defence in depth discovery endpoints already get — not a
 * reachable hole.
 */
describe('the host the Copilot exchange names', () => {
  it('is used when it is https', async () => {
    const result = await exchangeForCopilotToken(tokens, {
      fetch: stubExchange({ api: 'https://api.enterprise.githubcopilot.com' }),
    })

    expect(result.apiBaseUrl).toBe('https://api.enterprise.githubcopilot.com')
  })

  it('is used on cleartext loopback, where a local proxy is the normal case', async () => {
    const result = await exchangeForCopilotToken(tokens, {
      fetch: stubExchange({ api: 'http://127.0.0.1:8080' }),
    })

    expect(result.apiBaseUrl).toBe('http://127.0.0.1:8080')
  })

  it.each([
    ['cleartext', 'http://attacker.invalid/api'],
    ['a non-http scheme', 'ftp://nope.invalid'],
    ['not a URL at all', 'not-a-url-at-all'],
  ])('is refused when it is %s', async (_label, api) => {
    const attempt = exchangeForCopilotToken(tokens, { fetch: stubExchange({ api }) })

    await expect(attempt).rejects.toThrowError(OAuthError)
    // The message has to name the value: nothing else in the failure does.
    await expect(attempt).rejects.toThrowError(
      new RegExp(api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  it('leaves the descriptor default in place when none is named', async () => {
    const absent = await exchangeForCopilotToken(tokens, { fetch: stubExchange(undefined) })
    const empty = await exchangeForCopilotToken(tokens, { fetch: stubExchange({}) })

    expect(absent.apiBaseUrl).toBeUndefined()
    expect(empty.apiBaseUrl).toBeUndefined()
  })
})
