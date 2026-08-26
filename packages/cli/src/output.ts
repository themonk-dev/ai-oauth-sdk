/**
 * Terminal output helpers.
 *
 * Colour is written straight to stderr as ANSI, honouring NO_COLOR and
 * non-TTY output — a CLI whose whole job is printing a token into `$(...)`
 * must never colour stdout.
 */

const useColor =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  Boolean(process.stderr.isTTY)

const wrap = (code: number) => (text: string) => (useColor ? `[${code}m${text}[0m` : text)

export const dim = wrap(2)
export const bold = wrap(1)
export const red = wrap(31)
export const green = wrap(32)
export const yellow = wrap(33)
export const cyan = wrap(36)

/**
 * Control characters a terminal acts on, minus the two we want kept.
 *
 * C0 except tab and newline, DEL, and the C1 range — so ESC (and with it every
 * CSI and OSC sequence), BEL, NUL, and the bare CR that would return the cursor
 * to the start of the line we just wrote.
 */
const CONTROL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

/**
 * Strips terminal control characters from text we did not write.
 *
 * A good deal of what this CLI prints is chosen by the provider: an
 * `error_description` from a token endpoint, a device-flow verification URL, an
 * email off an id_token. With ESC intact, a hostile or compromised endpoint
 * does not have to stop at an ugly message — it can erase the `✗ Refresh
 * failed` line we just printed and paint a green `✓ Signed in as …` over it,
 * or set the terminal title, and the sequences survive into a redirected log
 * file to do it again to whoever reads that. `\t` and `\n` are left alone
 * because they are what multi-line provider text legitimately uses.
 *
 * Apply this to the untrusted value, never to a finished line: `wrap()` above
 * emits our own colour as a literal ESC, so running a composed line through
 * here would strip the CLI's own formatting along with the attack.
 *
 * Not applied to the access token itself — see {@link output}.
 */
export const plain = (text: string): string => text.replace(CONTROL, '')

/** Human-facing messages go to stderr, so stdout stays pipeable. */
export function info(message: string): void {
  process.stderr.write(`${message}\n`)
}

export function success(message: string): void {
  info(`${green('✓')} ${message}`)
}

export function warn(message: string): void {
  info(`${yellow('!')} ${message}`)
}

export function error(message: string): void {
  info(`${red('✗')} ${message}`)
}

/**
 * The actual result goes to stdout — this is what gets captured.
 *
 * Deliberately not run through {@link plain}. This prints a credential, and a
 * credential the CLI silently rewrote is a mystifying 401 somewhere downstream;
 * a token with something odd in it should stay visibly odd.
 */
export function output(value: string): void {
  process.stdout.write(`${value}\n`)
}

export function outputJson(value: unknown): void {
  output(JSON.stringify(value, null, 2))
}

/**
 * Renders rows as an aligned table on stderr.
 *
 * Cells are stripped before the widths are measured, not after. A cell holding
 * an escape sequence would otherwise be counted at its raw length and padded to
 * a width it does not occupy on screen, so a provider-supplied account label
 * could throw every column out of line.
 */
export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    return
  }

  const safeHeaders = headers.map(plain)
  const safeRows = rows.map((row) => row.map((cell) => plain(cell ?? '')))

  const widths = safeHeaders.map((header, column) =>
    Math.max(header.length, ...safeRows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd()

  info(bold(line(safeHeaders)))
  info(dim(widths.map((width) => '─'.repeat(width)).join('  ')))

  for (const row of safeRows) {
    info(line(row))
  }
}

export function formatExpiry(expiresAt: number | undefined): string {
  if (expiresAt === undefined) {
    return 'never'
  }

  const remaining = expiresAt - Date.now()

  if (remaining <= 0) {
    return 'expired'
  }

  const minutes = Math.floor(remaining / 60_000)

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
