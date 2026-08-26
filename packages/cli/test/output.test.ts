import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { plain, table } from '../src/output.js'

/**
 * Terminal control characters in provider-supplied text.
 *
 * A fair amount of what this CLI prints was chosen by the token endpoint — an
 * `error_description`, a device verification URL, an email out of an id_token.
 * With ESC intact that text is not merely ugly: it can erase the line the CLI
 * just wrote and paint a convincing success over it, and it does the same again
 * to anyone who later reads the log the output was redirected into.
 */
const ESC = '\u001B'

describe('plain', () => {
  it('strips ESC, so a forged success cannot be painted over a failure', () => {
    const attack = `Refresh failed${ESC}[2K${ESC}[1A${ESC}[32m✓ Signed in as attacker@evil.example`

    expect(plain(attack)).toBe(
      'Refresh failed[2K[1A[32m✓ Signed in as attacker@evil.example',
    )
  })

  it('strips the OSC sequence that renames the terminal window', () => {
    expect(plain(`${ESC}]0;pwned\u0007hello`)).toBe(']0;pwnedhello')
  })

  it('strips CR, NUL, DEL and the C1 range', () => {
    expect(plain('safe\roverwritten')).toBe('safeoverwritten')
    expect(plain('a\u0000b')).toBe('ab')
    expect(plain('a\u007Fb')).toBe('ab')
    expect(plain('a\u009Bb')).toBe('ab')
  })

  it('keeps tab, newline and every legitimate non-ASCII character', () => {
    expect(plain('a\tb\nc')).toBe('a\tb\nc')

    for (const sample of ['Ungültige Anfrage', '世界', 'Недействительный', '🚫 —', '«x»']) {
      expect(plain(sample)).toBe(sample)
    }
  })
})

describe('table', () => {
  let stderr: string[]

  beforeEach(() => {
    stderr = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))

      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('strips control characters out of headers and cells', () => {
    table(['provider', `acc${ESC}ount`], [['openai', `${ESC}[2Kevil@example.com`]])

    const written = stderr.join('')
    expect(written).not.toContain(ESC)
    /* The escape is gone; the text it was hiding in survives. */
    expect(written).toContain('account')
    expect(written).toContain('evil@example.com')
    expect(written).toContain('openai')
  })

  /*
   * Stripping after the widths were measured would be worth little: the cell
   * would be padded to the width of a string longer than the one that reaches
   * the screen, and every column after it would step sideways.
   */
  it('measures widths after stripping, so escapes cannot break alignment', () => {
    table(
      ['a', 'b'],
      [
        [`${ESC}${ESC}xx`, 'right'],
        ['yyyy', 'right'],
      ],
    )

    const rows = stderr
      .join('')
      .split('\n')
      .filter((line) => line.includes('right'))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe('xx    right')
    expect(rows[1]).toBe('yyyy  right')
  })
})
