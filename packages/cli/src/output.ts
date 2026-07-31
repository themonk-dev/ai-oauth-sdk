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

/** The actual result goes to stdout — this is what gets captured. */
export function output(value: string): void {
  process.stdout.write(`${value}\n`)
}

export function outputJson(value: unknown): void {
  output(JSON.stringify(value, null, 2))
}

/** Renders rows as an aligned table on stderr. */
export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    return
  }

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd()

  info(bold(line(headers)))
  info(dim(widths.map((width) => '─'.repeat(width)).join('  ')))

  for (const row of rows) {
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
