/**
 * A tiny argv parser.
 *
 * Hand-rolled rather than pulling in a dependency: the CLI's whole appeal is
 * that `npx ai-oauth-sdk` downloads almost nothing.
 */

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
      // `--flag value` unless the next token is another flag.
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
      // Short flags are boolean only; `-abc` sets a, b and c.
      for (const char of arg.slice(1)) {
        flags[char] = true
      }
      continue
    }

    positionals.push(arg)
  }

  return { command: positionals[0], positionals: positionals.slice(1), flags, passthrough }
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
