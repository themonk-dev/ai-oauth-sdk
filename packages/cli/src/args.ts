/**
 * A tiny argv parser.
 *
 * Hand-rolled rather than pulling in a dependency: the CLI's whole appeal is
 * that `npx ai-oauth-sdk` downloads almost nothing.
 *
 * `--flag value` binds the next token unless that token is itself a flag. Short
 * flags are boolean, and a cluster like `-vh` expands only when every character
 * in it is a real short flag. Anything else — `-device` — keeps its leading
 * dash as the flag name so `findUnknownFlag` can reject it, and can be reported
 * back to the user as the single word they actually typed rather than as a
 * handful of letters they never meant to write.
 */

/** The only single-character options the CLI reads. */
const SHORT_FLAGS = new Set(['h', 'v'])

export interface ParsedArgs {
  command: string | undefined
  positionals: string[]
  flags: Record<string, string | boolean>
  /** Everything after a bare `--`, passed through untouched. */
  passthrough: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  const passthrough: string[] = []

  let seenDoubleDash = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    if (seenDoubleDash) {
      passthrough.push(arg)
      continue
    }

    if (arg === '--') {
      seenDoubleDash = true
      continue
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const equals = body.indexOf('=')

      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1)
        continue
      }

      const next = argv[i + 1]

      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }

      continue
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1)

      if ([...body].every((char) => SHORT_FLAGS.has(char))) {
        for (const char of body) {
          flags[char] = true
        }
      } else {
        flags[arg] = true
      }

      continue
    }

    positionals.push(arg)
  }

  return { command: positionals[0], positionals: positionals.slice(1), flags, passthrough }
}

/** Every flag the CLI accepts. A typo used to be silently ignored. */
export const KNOWN_FLAGS = [
  'json',
  'account',
  'client-id',
  'client-secret',
  'scopes',
  'auth-dir',
  'device',
  'paste',
  'port',
  'timeout',
  'authorize-url',
  'token-url',
  'device-url',
  'force-refresh',
  'revoke',
  'env-var',
  'help',
  'version',
] as const

/**
 * Flags that read as reasonable but are not real, mapped to what to use.
 *
 * `--loopback` is the one people reach for, because it is the mode everything
 * else is named against — but it is the default, so accepting it silently made
 * it look like an override that did nothing.
 *
 * Prototype-free, because the key looked up here is whatever the user typed:
 * on a plain object literal `--toString` finds `Object.prototype.toString` and
 * prints a function where the type promises a hint string.
 */
const SUGGESTIONS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    loopback: 'loopback is the default — drop the flag, or use --paste / --device',
    browser: 'the browser flow is the default — drop the flag',
    'device-code': 'use --device',
    'client_id': 'use --client-id',
    'auth-directory': 'use --auth-dir',
    scope: 'use --scopes',
  },
)

/**
 * Returns a message for the first unrecognised flag, or undefined.
 *
 * `name` comes back ready to print, dashes included — a single-dash long option
 * keeps the one dash the user typed, everything else gets the two it was
 * missing.
 *
 * The real short flags are named here rather than waved through by their
 * length. A one-character key is not proof that the user wrote `-h`: `parseArgs`
 * produces one from the long form too, so `--r` lands as the key `r` and even
 * swallows the following token as its value. Skipping every short key therefore
 * accepted `--<any single letter>` silently, which is the exact failure this
 * guard exists to prevent — and worse here than a typo usually is, because
 * `ai-oauth-sdk logout acme --r` for `--revoke` prints the same "Signed out"
 * line while the refresh token stays live at the provider.
 */
export function findUnknownFlag(
  flags: Record<string, string | boolean>,
): { name: string; hint: string } | undefined {
  const known = new Set<string>([...KNOWN_FLAGS, ...SHORT_FLAGS])

  for (const name of Object.keys(flags)) {
    if (known.has(name)) {
      continue
    }

    const bare = name.replace(/^-+/, '')
    const shown = name.startsWith('-') ? name : `--${name}`

    if (known.has(bare)) {
      return { name: shown, hint: `Use --${bare} — one dash is not enough.` }
    }

    return {
      name: shown,
      hint: SUGGESTIONS[bare] ?? `Run \`ai-oauth-sdk --help\` for the full list.`,
    }
  }

  return undefined
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name]

  return typeof value === 'string' ? value : undefined
}

export function flagBoolean(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true'
}

export function flagNumber(
  flags: Record<string, string | boolean>,
  name: string,
): number | undefined {
  const value = flagString(flags, name)

  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : undefined
}
