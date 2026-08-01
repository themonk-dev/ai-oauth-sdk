import { spawn } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canOpenBrowser, escapeForCmd, openBrowser } from '../src/browser.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

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

/**
 * The suite sets `AI_OAUTH_SDK_NO_BROWSER`, so these restore whatever was there
 * rather than assuming it was unset.
 */
describe('AI_OAUTH_SDK_NO_BROWSER', () => {
  const original = process.env['AI_OAUTH_SDK_NO_BROWSER']

  beforeEach(() => {
    vi.mocked(spawn).mockClear()
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env['AI_OAUTH_SDK_NO_BROWSER']
    } else {
      process.env['AI_OAUTH_SDK_NO_BROWSER'] = original
    }
  })

  it('spawns nothing when set', () => {
    process.env['AI_OAUTH_SDK_NO_BROWSER'] = '1'

    openBrowser('https://provider.test/authorize')

    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports no browser when set, whatever the platform', () => {
    process.env['AI_OAUTH_SDK_NO_BROWSER'] = '1'

    expect(canOpenBrowser()).toBe(false)
  })

  it('still launches when unset', () => {
    delete process.env['AI_OAUTH_SDK_NO_BROWSER']

    openBrowser('https://provider.test/authorize')

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('leaves the platform check alone when unset', () => {
    delete process.env['AI_OAUTH_SDK_NO_BROWSER']

    const expected =
      process.platform === 'darwin' ||
      process.platform === 'win32' ||
      Boolean(process.env['DISPLAY'] ?? process.env['WAYLAND_DISPLAY'])

    expect(canOpenBrowser()).toBe(expected)
  })
})
