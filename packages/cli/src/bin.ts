import { run } from './index.js'

const exitCode = await run(process.argv.slice(2))

/*
 * Set the code rather than calling process.exit, so buffered stdout is flushed
 * before the process ends — otherwise `ai-oauth-sdk token … | cat` loses output.
 */
process.exitCode = exitCode
