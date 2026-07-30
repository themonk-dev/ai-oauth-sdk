import { describe, expect, it } from 'vitest'

import { escapeForCmd } from '../src/browser.js'

/**
 * Windows is the only platform where the URL passes through a shell parser.
 * `cmd.exe` re-reads the command line the child-process layer built, and that
 * layer quotes only arguments containing whitespace or quotes — so every
 * metacharacter in a URL has to be neutralised by hand.
 */
describe('escapeForCmd', () => {
  it('escapes the parameter separator, which every authorization URL has', () => {
    const url =
      'https://provider.test/authorize?response_type=code&client_id=abc&state=xyz&scope=a+b'
    const escaped = escapeForCmd(url)

    expect(escaped).not.toMatch(/(?<!\^)&/)
    expect(escaped).toBe(
      'https://provider.test/authorize?response_type=code^&client_id=abc^&state=xyz^&scope=a+b',
    )
  })

  it('escapes the rest of the cmd metacharacters', () => {
    expect(escapeForCmd('a|b')).toBe('a^|b')
    expect(escapeForCmd('a<b>c')).toBe('a^<b^>c')
    expect(escapeForCmd('a(b)c')).toBe('a^(b^)c')
    // `^` is itself the escape character, so it needs escaping too.
    expect(escapeForCmd('a^b')).toBe('a^^b')
  })

  it('escapes each character exactly once', () => {
    // A single pass, so an inserted `^` is never itself re-escaped.
    expect(escapeForCmd('&&')).toBe('^&^&')
    expect(escapeForCmd('^&')).toBe('^^^&')
  })

  it('leaves percent-encoding alone', () => {
    // `^` does not escape `%` in cmd, and an unmatched `%` already passes
    // through literally — touching it would corrupt the redirect URI.
    const encoded = 'https://p.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback'
    expect(escapeForCmd(encoded)).toBe(encoded)
  })

  it('leaves an ordinary URL untouched', () => {
    const plain = 'https://provider.test/authorize'
    expect(escapeForCmd(plain)).toBe(plain)
  })
})
