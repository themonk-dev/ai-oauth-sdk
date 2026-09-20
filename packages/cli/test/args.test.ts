import { describe, expect, it } from 'vitest'

import { findUnknownFlag, flagBoolean, flagNumber, flagString, parseArgs } from '../src/args.js'

describe('parseArgs', () => {
  it('splits command from positionals', () => {
    const parsed = parseArgs(['login', 'openai'])
    expect(parsed.command).toBe('login')
    expect(parsed.positionals).toEqual(['openai'])
  })

  it('reads --flag=value', () => {
    expect(parseArgs(['login', '--client-id=abc']).flags['client-id']).toBe('abc')
  })

  it('reads --flag value', () => {
    expect(parseArgs(['login', '--client-id', 'abc']).flags['client-id']).toBe('abc')
  })

  it('treats a flag followed by another flag as boolean', () => {
    const parsed = parseArgs(['login', '--device', '--json'])
    expect(parsed.flags['device']).toBe(true)
    expect(parsed.flags['json']).toBe(true)
  })

  it('treats a trailing flag as boolean', () => {
    expect(parseArgs(['login', 'openai', '--device']).flags['device']).toBe(true)
  })

  it('expands bundled short flags', () => {
    const parsed = parseArgs(['-vh'])
    expect(parsed.flags['v']).toBe(true)
    expect(parsed.flags['h']).toBe(true)
  })

  /*
   * `-device` used to explode into d/e/v/i/c/e — six one-character keys the
   * unknown-flag guard skips — so the typo ran a browser login instead.
   */
  it('keeps a single-dash long option intact so the guard can reject it', () => {
    const parsed = parseArgs(['login', 'openai', '-device'])

    expect(parsed.flags['device']).toBeUndefined()
    /* One dash, exactly as typed — not the "---device" a blind prefix produces. */
    expect(findUnknownFlag(parsed.flags)?.name).toBe('-device')
    expect(findUnknownFlag(parsed.flags)?.hint).toContain('--device')
  })

  /*
   * A one-character key is no proof the user typed `-h`: the long branch makes
   * one too, so `--r` lands as the key `r` and used to be skipped by a guard
   * that waved through anything a single character wide. `logout acme --r` for
   * `--revoke` then printed the same "Signed out" line and left the token live.
   */
  it.each([['--r'], ['--j'], ['--x']])('rejects %s, a long flag one character wide', (flag) => {
    expect(findUnknownFlag(parseArgs(['logout', 'acme', flag]).flags)?.name).toBe(flag)
  })

  it('still accepts the two short flags the CLI really reads', () => {
    expect(findUnknownFlag(parseArgs(['-vh']).flags)).toBeUndefined()
    expect(findUnknownFlag(parseArgs(['-h']).flags)).toBeUndefined()
    expect(findUnknownFlag(parseArgs(['-v']).flags)).toBeUndefined()
  })

  /*
   * The hint is looked up by whatever the user typed, so a plain object literal
   * answered `--toString` out of `Object.prototype` and printed a function
   * where the type promises a sentence.
   */
  it.each([['--toString'], ['--constructor'], ['--valueOf'], ['--__proto__']])(
    'does not take the hint for %s from Object.prototype',
    (flag) => {
      const unknown = findUnknownFlag(parseArgs(['login', flag]).flags)

      expect(unknown?.name).toBe(flag)
      expect(typeof unknown?.hint).toBe('string')
      expect(unknown?.hint).toContain('ai-oauth-sdk --help')
    },
  )

  /*
   * The other side of the same lookup. On a plain object literal `--__proto__`
   * never becomes an own property, so `Object.keys` reported nothing, the
   * unknown-flag guard had nothing to catch, and the flag was accepted and
   * discarded along with the argument after it.
   */
  it('sees --__proto__ as a flag rather than swallowing it', () => {
    const parsed = parseArgs(['logout', 'acme', '--__proto__', 'value'])

    expect(Object.keys(parsed.flags)).toEqual(['__proto__'])
    expect(parsed.positionals).toEqual(['acme'])
  })

  it('passes everything after -- through untouched', () => {
    const parsed = parseArgs(['exec', 'openai', '--', 'curl', '-H', 'X: 1', '--json'])
    expect(parsed.passthrough).toEqual(['curl', '-H', 'X: 1', '--json'])
    expect(parsed.flags['json']).toBeUndefined()
  })

  it('handles an empty argv', () => {
    const parsed = parseArgs([])
    expect(parsed.command).toBeUndefined()
    expect(parsed.positionals).toEqual([])
  })

  it('keeps a value that looks like a negative number', () => {
    // `--port -1` should not swallow -1 as a flag bundle.
    const parsed = parseArgs(['--port', '-1'])
    expect(parsed.flags['port']).toBe(true)
  })
})

describe('flag readers', () => {
  it('reads strings, ignoring booleans', () => {
    const { flags } = parseArgs(['--a=1', '--b'])
    expect(flagString(flags, 'a')).toBe('1')
    expect(flagString(flags, 'b')).toBeUndefined()
    expect(flagString(flags, 'missing')).toBeUndefined()
  })

  it('reads booleans from both forms', () => {
    const { flags } = parseArgs(['--a', '--b=true', '--c=no'])
    expect(flagBoolean(flags, 'a')).toBe(true)
    expect(flagBoolean(flags, 'b')).toBe(true)
    expect(flagBoolean(flags, 'c')).toBe(false)
  })

  it('reads numbers and rejects junk', () => {
    const { flags } = parseArgs(['--port=8080', '--bad=abc'])
    expect(flagNumber(flags, 'port')).toBe(8080)
    expect(flagNumber(flags, 'bad')).toBeUndefined()
    expect(flagNumber(flags, 'missing')).toBeUndefined()
  })
})
