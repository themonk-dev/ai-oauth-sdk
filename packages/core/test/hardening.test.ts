import { describe, expect, it } from 'vitest'

import { timingSafeEqual } from '../src/compare.js'
import { REDACTED, redactSecrets, safeSnippet } from '../src/redact.js'
import { createAuthClient } from '../src/client.js'
import { defineProvider } from '../src/providers/define.js'
import { memoryStorage } from '../src/storage.js'

describe('redactSecrets', () => {
  it('scrubs OAuth credential parameters in JSON', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      refresh_token: 'rt_live_abcdefghijklmnop',
      access_token: 'at_live_qrstuvwxyz012345',
      expires_in: 3600,
    })
    const redacted = redactSecrets(body)

    expect(redacted).not.toContain('rt_live_abcdefghijklmnop')
    expect(redacted).not.toContain('at_live_qrstuvwxyz012345')
    // Diagnostics we actually want must survive.
    expect(redacted).toContain('invalid_grant')
    expect(redacted).toContain('3600')
  })

  it('scrubs them in form encoding too', () => {
    const redacted = redactSecrets(
      'grant_type=refresh_token&refresh_token=secret-value-here&client_id=public',
    )
    expect(redacted).not.toContain('secret-value-here')
    expect(redacted).toContain('client_id=public')
  })

  it('scrubs the code and verifier, which are single-use but still credentials', () => {
    const redacted = redactSecrets('code=abc123def456&code_verifier=xyz789uvw012')
    expect(redacted).not.toContain('abc123def456')
    expect(redacted).not.toContain('xyz789uvw012')
  })

  it('scrubs a bare Authorization header value', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890')
  })

  it.each([
    ['Anthropic', 'sk-ant-oat01-AAAAAAAAAAAAAAAA'],
    ['OpenRouter', 'sk-or-v1-BBBBBBBBBBBBBBBB'],
    ['OpenAI', 'sk-proj-CCCCCCCCCCCCCCCCCCCC'],
    ['GitHub', 'ghu_DDDDDDDDDDDDDDDDDDDD'],
    ['Google', 'ya29.EEEEEEEEEEEEEEEE'],
  ])('scrubs a bare %s token by shape', (_label, token) => {
    const redacted = redactSecrets(`upstream said: ${token} is expired`)
    expect(redacted).not.toContain(token)
    expect(redacted).toContain(REDACTED)
  })

  it('scrubs a JWT, which is what an id_token looks like', () => {
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.signature'
    expect(redactSecrets(`token was ${jwt}`)).not.toContain(jwt)
  })

  it('leaves ordinary text alone', () => {
    const text = 'The upstream service returned HTTP 502 from cloudfront.'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('safeSnippet', () => {
  it('collapses whitespace and truncates', () => {
    const snippet = safeSnippet('a\n\n   b\t\tc', 100)
    expect(snippet).toBe('a b c')
  })

  it('truncates long bodies with an ellipsis', () => {
    const snippet = safeSnippet('x'.repeat(500), 50)
    expect(snippet).toHaveLength(51) // 50 + the ellipsis
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('redacts before truncating, so a secret cannot survive at the tail', () => {
    const body = `${'padding '.repeat(10)}refresh_token=super-secret-value`
    expect(safeSnippet(body, 500)).not.toContain('super-secret-value')
  })
})

describe('token errors never carry a credential', () => {
  /** A token endpoint that mirrors the request back, as a bad gateway would. */
  async function echoingServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const { createServer } = await import('node:http')
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.writeHead(502, { 'Content-Type': 'text/plain' })
        response.end(`Bad gateway. Upstream received: ${body}`)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections?.()
        }),
    }
  }

  it('does not leak the refresh token when the endpoint echoes the request', async () => {
    const target = await echoingServer()
    try {
      const client = createAuthClient({
        provider: defineProvider({
          id: 'echo',
          label: 'Echo',
          clientId: 'echo-client',
          authorizationUrl: `${target.url}/authorize`,
          tokenUrl: `${target.url}/token`,
          scopes: [],
          redirect: { mode: 'custom' },
        }),
        redirectUri: 'http://localhost/cb',
        storage: memoryStorage(),
      })

      await client.setTokens({
        accessToken: 'at-x',
        refreshToken: 'rt-super-secret-do-not-log',
        tokenType: 'Bearer',
        provider: 'echo',
        raw: {},
      })

      // This is the scenario: a gateway reflects our POST body, which contains
      // the refresh token, into an error page we then quote in a message.
      const error = await client.refresh().catch((caught: Error) => caught)
      expect(error).toBeInstanceOf(Error)

      const serialized = `${(error as Error).message} ${JSON.stringify(error)}`
      expect(serialized).not.toContain('rt-super-secret-do-not-log')
      expect(serialized).toContain(REDACTED)
      // The diagnostic value is still there.
      expect((error as Error).message).toContain('502')
    } finally {
      await target.close()
    }
  })
})

describe('timingSafeEqual', () => {
  it('matches equal strings', () => {
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('a'.repeat(43), 'a'.repeat(43))).toBe(true)
  })

  it('rejects any difference', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'Abc')).toBe(false)
    expect(timingSafeEqual('abc', '')).toBe(false)
    expect(timingSafeEqual('', 'abc')).toBe(false)
  })

  it('rejects on length regardless of a shared prefix', () => {
    // The prefix matching must not be enough; length is folded in.
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
  })

  it('handles non-ASCII without producing NaN', () => {
    expect(timingSafeEqual('héllo→', 'héllo→')).toBe(true)
    expect(timingSafeEqual('héllo→', 'héllo←')).toBe(false)
  })

  it('agrees with === over a spread of random pairs', () => {
    for (let i = 0; i < 300; i++) {
      const a = Math.random().toString(36).slice(2)
      const b = Math.random() < 0.5 ? a : Math.random().toString(36).slice(2)
      expect(timingSafeEqual(a, b), `${a} vs ${b}`).toBe(a === b)
    }
  })
})
