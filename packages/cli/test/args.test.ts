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

  /*
   * Every key here is a string the user typed, so the record cannot be an
   * object literal: `--__proto__ x` assigned to one is a silent no-op and the
   * flag vanished entirely, and `--constructor` read a value straight off
   * `Object.prototype`.
   */
  it('stores a flag named after an Object.prototype member', () => {
    const parsed = parseArgs(['login', '--__proto__', 'evil'])

    expect(Object.keys(parsed.flags)).toEqual(['__proto__'])
    expect(parsed.flags['__proto__']).toBe('evil')
    expect(findUnknownFlag(parsed.flags)?.name).toBe('--__proto__')
  })

  it('does not read a hint through the prototype chain', () => {
    const hint = findUnknownFlag(parseArgs(['login', '--constructor']).flags)?.hint

    expect(hint).toBe('Run `ai-oauth-sdk --help` for the full list.')
    expect(hint).not.toContain('native code')
  })
})

/*
 * `findUnknownFlag` skipped every one-character key, on the theory that those
 * are the short flags. They are not: `parseArgs` only ever stores a bare
 * one-character key for a real short flag, and an unrecognised `-x` keeps its
 * dash as the two-character key `-x`. So the skip was whitelisting every
 * *double*-dash single-character option. With two accounts stored,
 * `token acme --a work` printed the personal account's token and exited 0,
 * while the two-character typo `--ac` was rejected correctly.
 */
describe('findUnknownFlag — single-character options', () => {
  it.each(['a', 'c', 'e', 'p', 's'])('rejects the abbreviation --%s', (char) => {
    const unknown = findUnknownFlag(parseArgs(['token', 'acme', `--${char}`, 'work']).flags)

    expect(unknown?.name).toBe(`--${char}`)
  })

  it('rejects an abbreviation of a flag that really exists', () => {
    // `--a` is not `--account`, and guessing that it was is how the wrong
    // credential gets printed.
    expect(findUnknownFlag(parseArgs(['token', 'acme', '--a=work']).flags)?.name).toBe('--a')
  })

  it('still accepts the real short flags, alone and bundled', () => {
    expect(findUnknownFlag(parseArgs(['-h']).flags)).toBeUndefined()
    expect(findUnknownFlag(parseArgs(['-v']).flags)).toBeUndefined()
    expect(findUnknownFlag(parseArgs(['-vh']).flags)).toBeUndefined()
  })

  it('still reports the one-dash long options it always reported', () => {
    expect(findUnknownFlag(parseArgs(['-device']).flags)?.name).toBe('-device')
    expect(findUnknownFlag(parseArgs(['-x']).flags)?.name).toBe('-x')
  })

  it('accepts --h and --v, which are spelled like the flags they name', () => {
    // `parseArgs` stores these under the same bare key as `-h`/`-v`, and the
    // commands read them from there, so rejecting them would be a regression.
    expect(findUnknownFlag(parseArgs(['--h']).flags)).toBeUndefined()
    expect(findUnknownFlag(parseArgs(['--v']).flags)).toBeUndefined()
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
