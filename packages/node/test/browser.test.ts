import { spawn } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canOpenBrowser, openBrowser } from '../src/browser.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

/** Runs `body` with `process.platform` reporting `platform`. */
function onPlatform(platform: NodeJS.Platform, body: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })

  try {
    body()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

/**
 * Windows used to be the one platform where the URL passed through a shell
 * parser: `start` is a `cmd` builtin, so the launcher spawned `cmd /c start ""
 * <url>` and `cmd` re-read the command line the child-process layer had built.
 * These pin that it does not any more, because the two holes that opened were
 * not escapable — `^` escapes neither `%` nor a carriage return on a `cmd`
 * command line.
 */
describe('openBrowser on win32', () => {
  const original = process.env['AI_OAUTH_SDK_NO_BROWSER']

  beforeEach(() => {
    vi.mocked(spawn).mockClear()
    delete process.env['AI_OAUTH_SDK_NO_BROWSER']
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env['AI_OAUTH_SDK_NO_BROWSER']
    } else {
      process.env['AI_OAUTH_SDK_NO_BROWSER'] = original
    }
  })

  it('launches through rundll32, with no shell in the chain', () => {
    const url =
      'https://provider.test/authorize?response_type=code&client_id=abc&state=xyz&scope=a+b'

    onPlatform('win32', () => openBrowser(url))

    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!

    // Microsoft's documented URL-opening entry point. It takes the URL as an
    // argv entry and performs no second parse of the command line.
    expect(command).toBe('rundll32')
    expect(args).toEqual(['url.dll,FileProtocolHandler', url])
    // Nothing in the chain is a shell, so nothing re-reads the command line.
    expect(command).not.toBe('cmd')
    expect(args).not.toContain('/c')
    expect(options).not.toHaveProperty('shell', true)
  })

  it('passes the URL through verbatim, `&` and `%VAR%` included', () => {
    // The old path escaped `&` by hand and left `%` alone on purpose, since
    // `^` cannot escape it — so `cmd` expanded `%USERPROFILE%` and the browser
    // requested a URL carrying the user's home directory. With no shell there
    // is nothing to expand and nothing to escape.
    const url = 'https://evil.test/?x=%USERPROFILE%&y=a|b&z=(c)'

    onPlatform('win32', () => openBrowser(url))

    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(['url.dll,FileProtocolHandler', url])
  })

  it.each([
    ['carriage return and line feed', 'https://evil.test/a\r\ncalc.exe\r\n'],
    ['a bare line feed', 'https://evil.test/a\ncalc.exe'],
    ['a tab', 'https://evil.test/a\tb'],
    ['a NUL', 'https://evil.test/a\u0000b'],
    ['DEL', 'https://evil.test/a\u007Fb'],
  ])('refuses to spawn for a URL containing %s', (_label, url) => {
    // Belt-and-braces, and not Windows-specific: the URL parser strips TAB, CR
    // and LF while validating, so a value can survive a `new URL()` scheme
    // check with the break still in it. The caller prints the URL instead.
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      vi.mocked(spawn).mockClear()
      onPlatform(platform, () => openBrowser(url))
      expect(spawn, `should not spawn on ${platform}`).not.toHaveBeenCalled()
    }
  })

  it('leaves the darwin and linux launchers alone', () => {
    const url = 'https://provider.test/authorize?a=1&b=2'

    onPlatform('darwin', () => openBrowser(url))
    expect(vi.mocked(spawn).mock.calls[0]?.slice(0, 2)).toEqual(['open', [url]])

    vi.mocked(spawn).mockClear()
    onPlatform('linux', () => openBrowser(url))
    expect(vi.mocked(spawn).mock.calls[0]?.slice(0, 2)).toEqual(['xdg-open', [url]])
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
