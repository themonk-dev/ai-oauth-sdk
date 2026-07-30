import { describe, expect, it } from 'vitest'

import { buildAuthorizationUrl } from '../src/authorize.js'
import { defineProvider, parseStandardCallback } from '../src/providers/index.js'
import { appendQuery, encodeQuery, parseQuery } from '../src/query.js'

const provider = defineProvider({
  id: 'demo',
  label: 'Demo',
  clientId: 'demo-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid', 'profile'],
  redirect: { mode: 'custom' },
})

describe('encodeQuery — parity with URLSearchParams', () => {
  // The whole point of hand-rolling this is that React Native's URL shim
  // cannot be used. That is only safe if the bytes are identical to what every
  // other runtime would have sent, so assert it rather than assume it.
  it('matches URLSearchParams across the ASCII range', () => {
    const mismatches: string[] = []
    for (let code = 0; code < 128; code++) {
      for (const suffix of ['', 'x', ' ', '%']) {
        const value = String.fromCharCode(code) + suffix
        const ours = encodeQuery({ k: value })
        const theirs = new URLSearchParams({ k: value }).toString()
        if (ours !== theirs) {
          mismatches.push(`${JSON.stringify(value)}: ${ours} !== ${theirs}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('matches URLSearchParams for the values OAuth actually sends', () => {
    const values = [
      'openid profile email offline_access',
      'urn:ietf:params:oauth:grant-type:device_code',
      'http://localhost:1455/auth/callback',
      'sk-ant-abc_123-XYZ~',
      "quote'paren()bang!tilde~star*",
      'ünïcode-é中🔑',
      'a+b&c=d%20e',
      '',
    ]
    for (const value of values) {
      expect(encodeQuery({ k: value })).toBe(new URLSearchParams({ k: value }).toString())
    }
  })

  it('encodes keys as well as values', () => {
    expect(encodeQuery({ 'a key': 'a value' })).toBe(
      new URLSearchParams({ 'a key': 'a value' }).toString(),
    )
  })
})

describe('parseQuery', () => {
  it('round-trips everything encodeQuery produces', () => {
    const original = {
      scope: 'openid profile email',
      redirect_uri: 'http://localhost:1455/cb?x=1',
      state: "a+b&c=d~e!f'g()",
      empty: '',
    }
    expect(parseQuery(encodeQuery(original))).toEqual(original)
  })

  it('reads `+` as a space, the way form encoding means it', () => {
    expect(parseQuery('scope=openid+profile')).toEqual({ scope: 'openid profile' })
  })

  it('tolerates a malformed percent escape instead of throwing', () => {
    // decodeURIComponent would throw on a stray `%`; a bad value must not stop
    // the rest of a callback being read.
    expect(parseQuery('code=abc&junk=100%')).toEqual({ code: 'abc', junk: '100%' })
  })

  it('handles a key with no value, and ignores empty pairs', () => {
    expect(parseQuery('a&&b=1')).toEqual({ a: '', b: '1' })
  })
})

describe('appendQuery', () => {
  it('adds a query where there is none', () => {
    expect(appendQuery('https://x.test/auth', { a: '1' })).toBe('https://x.test/auth?a=1')
  })

  it('merges with an existing query, ours winning', () => {
    expect(appendQuery('https://x.test/auth?a=old&keep=yes', { a: 'new' })).toBe(
      'https://x.test/auth?a=new&keep=yes',
    )
  })

  it('keeps a fragment after the query', () => {
    expect(appendQuery('https://x.test/auth#frag', { a: '1' })).toBe('https://x.test/auth?a=1#frag')
  })

  it('returns the url untouched when there is nothing to add', () => {
    expect(appendQuery('https://x.test/auth', {})).toBe('https://x.test/auth')
  })
})

describe('the OAuth path on a runtime with no usable URL/URLSearchParams', () => {
  /**
   * React Native's built-in URL shim implements the constructor and toString
   * but throws from `searchParams`, and its URLSearchParams has historically
   * accepted only an object. Remove both entirely — a stricter environment
   * than Hermes — and the flow must still work.
   */
  function withoutUrlGlobals<T>(body: () => T): T {
    const realUrl = globalThis.URL
    const realParams = globalThis.URLSearchParams
    // @ts-expect-error deliberately removing a global for the duration
    delete globalThis.URL
    // @ts-expect-error deliberately removing a global for the duration
    delete globalThis.URLSearchParams
    try {
      return body()
    } finally {
      globalThis.URL = realUrl
      globalThis.URLSearchParams = realParams
    }
  }

  it('builds an authorization URL', () => {
    const url = withoutUrlGlobals(() =>
      buildAuthorizationUrl({
        provider,
        clientId: 'demo-client',
        redirectUri: 'myapp://auth/callback',
        state: 'st-123',
        codeChallenge: 'ch-456',
        codeChallengeMethod: 'S256',
      }),
    )

    expect(url).toContain('https://provider.test/authorize?')
    expect(url).toContain('redirect_uri=myapp%3A%2F%2Fauth%2Fcallback')
    expect(url).toContain('scope=openid+profile')
    expect(url).toContain('code_challenge=ch-456')
    expect(url).toContain('state=st-123')
  })

  it('parses the callback that comes back', () => {
    expect(
      withoutUrlGlobals(() => parseStandardCallback('myapp://auth/callback?code=abc&state=st-123')),
    ).toEqual({ code: 'abc', state: 'st-123' })
  })
})
