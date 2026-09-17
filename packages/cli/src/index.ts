import { isOAuthError } from '@ai-oauth-sdk/core'

import { findUnknownFlag, flagBoolean, parseArgs } from './args.js'
import * as commands from './commands.js'
import { CliError } from './commands.js'
import { helpText } from './help.js'
import { dim, error, info } from './output.js'

export { parseArgs } from './args.js'
export type { ParsedArgs } from './args.js'
export { CliError } from './commands.js'
export { helpText } from './help.js'

const HANDLERS: Record<string, (context: { args: ReturnType<typeof parseArgs>; json: boolean }) => Promise<number | void>> = {
  login: commands.login,
  token: commands.token,
  whoami: commands.whoami,
  list: commands.list,
  ls: commands.list,
  logout: commands.logout,
  refresh: commands.refresh,
  providers: commands.listProviders,
  exec: commands.exec,
}

/**
 * Runs the CLI and returns a process exit code.
 *
 * Returning rather than calling `process.exit` keeps this testable and lets
 * `exec` propagate the child's exit code faithfully.
 */
export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const json = flagBoolean(args.flags, 'json')

  // Before the help branch below, which matches on "no command" and would
  // otherwise answer `ai-oauth-sdk -v` with the help text.
  if (args.command === 'version' || flagBoolean(args.flags, 'version') || flagBoolean(args.flags, 'v')) {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version: string }
    info(pkg.version)

    return 0
  }

  if (args.command === 'help' || flagBoolean(args.flags, 'help') || flagBoolean(args.flags, 'h')) {
    info(helpText())

    return 0
  }

  // `Object.hasOwn` rather than a bare index read: `HANDLERS` is a plain object
  // literal, so `HANDLERS['constructor']` — or `'toString'`, `'valueOf'`,
  // `'__proto__'` — finds something inherited from `Object.prototype`. That
  // value is truthy, so the unknown-command branch below is skipped and the
  // inherited member is called as though it were a command handler:
  // `ai-oauth-sdk constructor` returned 0 with nothing on stdout or stderr at
  // all, and `valueOf` surfaced an internal JS error in place of the message.
  // The command name comes straight off the argv a user typed, so every name
  // that is not one of the keys written above has to be rejected the same way
  // `frobnicate` is.
  const handler = args.command && Object.hasOwn(HANDLERS, args.command) ? HANDLERS[args.command] : undefined

  // An unknown command is reported ahead of an unknown option, because the
  // command is what decides which options are known in the first place.
  if (args.command && !handler) {
    error(`Unknown command "${args.command}".`)
    info(dim('Run `ai-oauth-sdk help` to see the available commands.'))

    return 1
  }

  const unknown = findUnknownFlag(args.flags)

  if (unknown) {
    error(`Unknown option "${unknown.name}".`)
    info(dim(`  ${unknown.hint}`))

    return 1
  }

  // A bare invocation asks for help. Flags with no command are a mistake, and
  // saying so beats printing help and exiting 0 as though it worked.
  if (!handler) {
    info(helpText())

    return Object.keys(args.flags).length === 0 ? 0 : 1
  }

  try {
    const result = await handler({ args, json })

    return typeof result === 'number' ? result : 0
  } catch (caught) {
    if (caught instanceof CliError) {
      error(caught.message)

      if (caught.hint) {
        info(dim(`  ${caught.hint}`))
      }

      return 1
    }

    if (isOAuthError(caught)) {
      error(`${caught.code}: ${caught.message}`)

      if (caught.code === 'refresh_failed') {
        info(dim('  Sign in again to continue.'))
      }

      if (caught.code === 'aborted') {
        return 130
      }

      return 1
    }

    error(caught instanceof Error ? caught.message : String(caught))

    return 1
  }
}
