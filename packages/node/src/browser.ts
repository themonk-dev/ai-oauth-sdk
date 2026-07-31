import { spawn } from 'node:child_process'

/**
 * Escapes the characters `cmd.exe` treats as syntax.
 *
 * On Windows the launcher has to go through `cmd`, and `cmd` re-parses the
 * command line *after* the child-process layer has built it. That layer only
 * quotes arguments containing whitespace or quotes, so a bare `&` survives into
 * `cmd` as a command separator — and every OAuth authorization URL is a string
 * of `&`-separated parameters. Without this the browser receives the URL
 * truncated at the first parameter and `cmd` tries to execute the remainder.
 *
 * `%` is deliberately left alone: `^` does not escape it, and an unmatched `%`
 * (which is what percent-encoding produces) is already passed through
 * literally.
 */
export function escapeForCmd(value: string): string {
  return value.replace(/[&|^<>()]/g, (character) => `^${character}`)
}

/**
 * Opens a URL in the user's default browser.
 *
 * Implemented with `spawn` rather than a dependency like `open` to keep the
 * package dependency-free. Uses argument arrays (never a shell string), so on
 * macOS and Linux the URL reaches the launcher untouched.
 */
export function openBrowser(url: string): void {
  const platform = process.platform

  let command: string
  let args: string[]

  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    /* `start` is a cmd builtin; the empty string is the required window title. */
    command = 'cmd'
    args = ['/c', 'start', '', escapeForCmd(url)]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* caller falls back to printing the URL */
  }
}

/** True when there is plausibly a browser to open (i.e. not a headless box). */
export function canOpenBrowser(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return true
  }

  return Boolean(process.env['DISPLAY'] ?? process.env['WAYLAND_DISPLAY'])
}
