import { isOAuthError } from '@ai-oauth-sdk/core'

import { flagBoolean, parseArgs } from './args.js'
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

  if (!args.command || args.command === 'help' || flagBoolean(args.flags, 'help') || flagBoolean(args.flags, 'h')) {
    info(helpText())
    return args.command && args.command !== 'help' ? 1 : 0
  }

  if (args.command === 'version' || flagBoolean(args.flags, 'version') || flagBoolean(args.flags, 'v')) {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version: string }
    info(pkg.version)
    return 0
  }

  const handler = HANDLERS[args.command]
  if (!handler) {
    error(`Unknown command "${args.command}".`)
    info(dim('Run `ai-oauth-sdk help` to see the available commands.'))
    return 1
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
      // The two failures a user can actually act on.
      if (caught.code === 'refresh_failed') {
        info(dim('  Sign in again to continue.'))
      }
      if (caught.code === 'aborted') {return 130} // conventional SIGINT code
      return 1
    }
    error(caught instanceof Error ? caught.message : String(caught))
    return 1
  }
}
