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
 * literally. That does mean a `%VAR%` in the URL is expanded by `cmd`, which
 * `isLaunchableUrl` cannot help with either — closing that would mean not
 * going through `cmd` at all.
 */
export function escapeForCmd(value: string): string {
  return value.replace(/[&|^<>()]/g, (character) => `^${character}`)
}

/** DEL, and the upper bound of the C0 control block. */
const DELETE_CODE = 0x7f
const LAST_CONTROL_CODE = 0x1f
const DOUBLE_QUOTE_CODE = 0x22

/**
 * Whether a URL is safe to hand to the platform's launcher.
 *
 * A URL has no legitimate use for a C0 control character — RFC 3986 has no
 * production for one — and refusing them is a security check rather than
 * tidiness because of what the WHATWG parser does with them: it strips CR, LF
 * and tab *before* it parses. So a validator built on `new URL()` approves the
 * stripped string while the raw one is what gets stored and used. An
 * `authorization_endpoint` of `https://evil.test/a<CR><LF>calc<CR><LF>` passes
 * an https check, survives `appendQuery` (which copies everything before the
 * first `?` verbatim), and arrives here — and `escapeForCmd` has no answer for
 * it, because a bare newline is a command separator that `^` cannot
 * neutralise. Every serious attempt at this problem (Rust's standard library,
 * BatBadBut, shescape) concluded a newline has to be refused rather than
 * escaped.
 *
 * A raw `"` is refused on the same practical grounds. The child-process layer
 * quotes any argument containing one, `^` is inert inside a `cmd` quoted
 * region, and so every escape this module inserted would degrade to literal
 * text and hand the browser a corrupted URL. A well-formed URL percent-encodes
 * it.
 *
 * Checked on every platform, not just Windows. macOS and Linux take the URL as
 * a plain `argv` entry with no shell, so they are not vulnerable — but a URL
 * carrying these characters is malformed everywhere, and one rule is easier to
 * reason about than a rule that only holds on the platform nobody tests on.
 */
export function isLaunchableUrl(url: string): boolean {
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index)

    if (code <= LAST_CONTROL_CODE || code === DELETE_CODE || code === DOUBLE_QUOTE_CODE) {
      return false
    }
  }

  return true
}

/**
 * Whether launching a browser has been switched off for this process.
 *
 * Set `AI_OAUTH_SDK_NO_BROWSER` in a test suite or a CI job that drives a login
 * end to end. Without it every completed flow spawns the machine's URL handler,
 * which on a developer's laptop means a tab per test pointing at a port that
 * closed when the fixture did.
 */
function browserDisabled(): boolean {
  return Boolean(process.env['AI_OAUTH_SDK_NO_BROWSER'])
}

/**
 * Opens a URL in the user's default browser.
 *
 * Implemented with `spawn` rather than a dependency like `open` to keep the
 * package dependency-free. Uses argument arrays (never a shell string), so on
 * macOS and Linux the URL reaches the launcher untouched.
 *
 * A URL `isLaunchableUrl` rejects is not launched at all. Refusing silently is
 * what the `spawn` failure below already does, and every caller prints the URL
 * before getting here, so the user still has something to click.
 */
export function openBrowser(url: string): void {
  if (browserDisabled()) {
    return
  }

  if (!isLaunchableUrl(url)) {
    return
  }

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
  if (browserDisabled()) {
    return false
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    return true
  }

  return Boolean(process.env['DISPLAY'] ?? process.env['WAYLAND_DISPLAY'])
}
