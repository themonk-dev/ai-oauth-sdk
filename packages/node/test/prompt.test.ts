import { stderr, stdin, stdout } from 'node:process'

import { describe, expect, it, vi } from 'vitest'

import { defineProvider } from '@ai-oauth-sdk/core'

import { defaultReceiver } from '../src/index.js'
import { promptReceiver } from '../src/prompt.js'

const hostedProvider = defineProvider({
  id: 'paste-test',
  label: 'Paste Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  redirect: { mode: 'hosted', hostedUri: 'https://provider.test/code' },
})

/**
 * Captures both standard streams for the duration of one call.
 *
 * Spying on `write` rather than swapping the descriptor is deliberate: the
 * streams have to stay real, because readline reads `isTTY` off the one it is
 * handed to decide whether to draw a prompt at all, and a plain object would
 * quietly change the thing under test.
 */
async function capturingStreams<T>(body: () => Promise<T>): Promise<{
  value: T
  onStdout: string
  onStderr: string
}> {
  const out: string[] = []
  const err: string[] = []
  const stdoutSpy = vi.spyOn(stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))

    return true
  })
  const stderrSpy = vi.spyOn(stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))

    return true
  })

  try {
    const value = await body()

    return { value, onStdout: out.join(''), onStderr: err.join('') }
  } finally {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  }
}

/*
 * `packages/cli/src/output.ts` states the contract: stdout carries the data and
 * nothing else, so `login … --json > out.json` captures parseable JSON. This
 * receiver used to write both the instructions and readline's own prompt string
 * there, which put human text into that file and left the user staring at a
 * terminal showing nothing while it waited on them.
 *
 * Not a credential leak, and the tests below deliberately do not claim one: with
 * stdout redirected readline sees a non-TTY output, sets `terminal` false and
 * echoes nothing. What the user sees of their own paste is the tty echoing
 * stdin, which never enters the redirected stream.
 */
describe('promptReceiver keeps stdout clear', () => {
  it('writes the instructions and the readline prompt to stderr', async () => {
    const { value, onStdout, onStderr } = await capturingStreams(async () => {
      const started = await promptReceiver({ openBrowser: false }).start({
        provider: hostedProvider,
      })

      try {
        await started.present('https://provider.test/authorize?state=xyz')
        const waiting = started.wait()
        stdin.push('code=code-from-the-user&state=xyz\n')

        return await waiting
      } finally {
        await started.close()
      }
    })

    expect(value).toMatchObject({ code: 'code-from-the-user' })
    // Nothing at all on the data channel — not the URL, and not readline's
    // prompt, which reaches `output` even when `terminal` is false and so is the
    // half that moving the `message` write alone would have left behind.
    expect(onStdout).toBe('')
    expect(onStderr).toContain('https://provider.test/authorize?state=xyz')
    expect(onStderr).toContain('Paste the authorization code or URL:')
  })

  it('sends a caller-supplied message to stderr as well', async () => {
    const { onStdout, onStderr } = await capturingStreams(async () => {
      const started = await promptReceiver({
        openBrowser: false,
        message: (url) => `custom instructions for ${url}\n`,
      }).start({ provider: hostedProvider })

      try {
        await started.present('https://provider.test/authorize')
        const waiting = started.wait()
        stdin.push('code=pasted-code\n')
        await waiting
      } finally {
        await started.close()
      }
    })

    expect(onStdout).toBe('')
    expect(onStderr).toContain('custom instructions for https://provider.test/authorize')
  })
})

/*
 * The same contract, one branch away. `defaultReceiver` writes the authorization
 * URL itself for a provider that neither supports a local redirect nor publishes
 * a hosted page, and that branch had its own `process.stdout.write`. Fixing only
 * the prompt receiver would have left the CLI's `--json` output corrupted for
 * exactly the providers that take this path.
 */
describe('defaultReceiver keeps stdout clear', () => {
  it('prints the authorization URL to stderr in its printing branch', async () => {
    const customProvider = defineProvider({
      id: 'custom-redirect-test',
      label: 'Custom Redirect Test',
      clientId: 'c',
      authorizationUrl: 'https://provider.test/authorize',
      tokenUrl: 'https://provider.test/token',
      scopes: [],
      redirect: { mode: 'custom' },
    })

    const { onStdout, onStderr } = await capturingStreams(async () => {
      const started = await defaultReceiver(customProvider).start({ provider: customProvider })

      try {
        await started.present('https://provider.test/authorize?state=abc')
      } finally {
        await started.close()
      }
    })

    expect(onStdout).toBe('')
    expect(onStderr).toContain('https://provider.test/authorize?state=abc')
  })
})
