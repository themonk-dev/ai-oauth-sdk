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

  /*
   * Byte-exact, because the snippet is read by a human. Redaction that leaves a
   * stray quote behind corrupts the diagnostic it was supposed to preserve.
   */
  it('leaves the surrounding body intact', () => {
    expect(redactSecrets('{"refresh_token":"abc12345","expires_in":3600}')).toBe(
      '{"refresh_token":[redacted],"expires_in":3600}',
    )
    expect(redactSecrets("{'refresh_token': 'abc12345'}")).toBe("{'refresh_token': [redacted]}")
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

  /*
   * A gateway that echoes our request back does not always hand it back as it
   * received it. Wrapping the body into a JSON envelope escapes every quote in
   * it, so the parameter name is followed by `\":\"` rather than `":"`.
   */
  it('scrubs a credential in JSON that was embedded as a string inside JSON', () => {
    const inner = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: 'rt_live_9f3a2b7c1d4e5f60',
    })
    const redacted = redactSecrets(JSON.stringify({ upstream_body: inner }))

    expect(redacted).not.toContain('rt_live_9f3a2b7c1d4e5f60')
    expect(redacted).toContain(REDACTED)
  })

  it('scrubs one that was wrapped twice over', () => {
    const inner = JSON.stringify({ refresh_token: 'rt_live_0011223344556677' })
    const redacted = redactSecrets(JSON.stringify({ m: JSON.stringify({ upstream_body: inner }) }))

    expect(redacted).not.toContain('rt_live_0011223344556677')
    expect(redacted).toContain(REDACTED)
  })

  /*
   * The value class has to keep accepting a backslash. Excluding it to make the
   * escaped forms above match would fail the whole match on a value that simply
   * contains one, and a failed match prints the credential.
   */
  it('does not leak a credential whose value contains a backslash', () => {
    const redacted = redactSecrets(String.raw`{"refresh_token":"ab\cdefgh12345678"}`)
    expect(redacted).not.toContain('cdefgh12345678')
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
    /* 50 characters plus the ellipsis. */
    expect(snippet).toHaveLength(51)
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

  /*
   * The body above is text, so it reaches the message as it was sent. This one
   * is valid JSON that `readTokenError` finds nothing in — no `error`, no
   * `error_description`, no `detail`, no nested `error.message` — so it falls
   * back to a snippet of the raw body, still escaped exactly as the gateway
   * wrote it. That is the shape the escaped-quote case above arrives in.
   */
  it('does not leak the refresh token when the echo is wrapped in a JSON envelope', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.writeHead(502, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ upstream_status: 502, upstream_body: body }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }

    try {
      const client = createAuthClient({
        provider: defineProvider({
          id: 'wrap',
          label: 'Wrap',
          clientId: 'c',
          authorizationUrl: `http://127.0.0.1:${port}/authorize`,
          tokenUrl: `http://127.0.0.1:${port}/token`,
          scopes: [],
          redirect: { mode: 'custom' },
          // As `openrouter` posts, so the echoed body is JSON inside JSON.
          tokenRequest: { style: 'json' },
        }),
        redirectUri: 'http://localhost/cb',
        storage: memoryStorage(),
      })

      await client.setTokens({
        accessToken: 'at',
        refreshToken: 'rt_live_9f3a2b7c1d4e5f60',
        tokenType: 'Bearer',
        provider: 'wrap',
        raw: {},
      })

      const error = await client.refresh().catch((caught: Error) => caught)
      const serialized = `${(error as Error).message} ${JSON.stringify(error)}`

      expect(serialized).not.toContain('rt_live_9f3a2b7c1d4e5f60')
      expect(serialized).toContain(REDACTED)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  })

  /*
   * `readTokenError` reads a nested `message` and a bare `detail`, neither of
   * which existed when the redaction was written. Both are provider text, so
   * both have to be scrubbed before they reach a message or a log.
   */
  it('redacts a credential quoted in a JSON error body', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_request, response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          detail:
            'Upstream received: grant_type=refresh_token&refresh_token=rt-leaked-in-detail',
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }

    try {
      const client = createAuthClient({
        provider: defineProvider({
          id: 'jsonerr',
          label: 'JsonErr',
          clientId: 'c',
          authorizationUrl: `http://127.0.0.1:${port}/authorize`,
          tokenUrl: `http://127.0.0.1:${port}/token`,
          scopes: [],
          redirect: { mode: 'custom' },
        }),
        redirectUri: 'http://localhost/cb',
        storage: memoryStorage(),
      })

      await client.setTokens({
        accessToken: 'at',
        refreshToken: 'rt-leaked-in-detail',
        tokenType: 'Bearer',
        provider: 'jsonerr',
        raw: {},
      })

      const error = await client.refresh().catch((caught: Error) => caught)
      const serialized = `${(error as Error).message} ${JSON.stringify(error)}`

      expect(serialized).not.toContain('rt-leaked-in-detail')
      expect(serialized).toContain(REDACTED)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
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
