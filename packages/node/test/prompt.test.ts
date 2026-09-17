import { describe, expect, it, vi } from 'vitest'

import { defineProvider } from '@ai-oauth-sdk/core'

import { promptReceiver } from '../src/prompt.js'

/** Every browser launch, without launching one. */
const { browserLaunches } = vi.hoisted(() => ({ browserLaunches: [] as string[] }))

vi.mock('../src/browser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser.js')>()),
  openBrowser: (url: string) => {
    browserLaunches.push(url)
  },
}))

const provider = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  redirect: { mode: 'hosted', hostedUri: 'https://provider.test/callback' },
})

/** Collects what the receiver prints, and keeps it out of the suite's output. */
const captureStdout = () => {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))

    return true
  })

  return { chunks, restore: () => spy.mockRestore() }
}

const occurrences = (chunks: string[], needle: string) =>
  chunks.join('').split(needle).length - 1

describe('promptReceiver', () => {
  /*
   * The readline used to be created and closed inside the question itself, so a
   * caller that stopped waiting — `--timeout`, an abort, a racing receiver that
   * won — left one open on stdin with a question still pending. The command
   * printed its error and then never exited: `login claude --paste --timeout 2`
   * reported the timeout at 2s and was still running when the harness killed it.
   */
  it('lets go of stdin when the login is abandoned mid-question', async () => {
    const before = process.stdin.listenerCount('data')
    const output = captureStdout()

    try {
      const started = await promptReceiver({ openBrowser: false, message: () => '' }).start({
        provider,
      })
      await started.present('https://provider.test/authorize')
      expect(process.stdin.listenerCount('data')).toBeGreaterThan(before)

      await started.close()
      expect(process.stdin.listenerCount('data')).toBe(before)
    } finally {
      output.restore()
    }
  })

  /*
   * Asking again is asking again, not starting over: the instructions and the
   * browser belong to the login. Re-presenting the receiver would have been the
   * naive way to get a second prompt, and it prints the authorization URL twice
   * and opens a second tab on it.
   */
  it(
    'announces once however many times it asks',
    async () => {
      browserLaunches.length = 0
      const output = captureStdout()

      try {
        const started = await promptReceiver({
          retryOnInvalidPaste: true,
          message: () => 'OPEN THIS\n',
        }).start({ provider })

        await started.present('https://provider.test/authorize')
        const pending = started.wait()

        process.stdin.push('nothing parseable\n')
        await new Promise((resolve) => setTimeout(resolve, 100))
        process.stdin.push('https://provider.test/callback?code=abc&state=s\n')

        await expect(pending).resolves.toEqual({ code: 'abc', state: 's' })
        expect(occurrences(output.chunks, 'OPEN THIS')).toBe(1)
        expect(browserLaunches).toEqual(['https://provider.test/authorize'])
        /* Asked twice, and told why the first one did not take. */
        expect(occurrences(output.chunks, 'Paste the authorization code or URL')).toBe(2)
        expect(occurrences(output.chunks, 'Could not find an authorization code')).toBe(1)

        await started.close()
      } finally {
        output.restore()
      }
    },
    5_000,
  )

  /*
   * And without the opt-in, one paste is one answer — `login claude --paste`
   * has no second receiver to end the wait, so a loop there would be a hang.
   */
  it(
    'fails the login on a bad paste when retrying is not asked for',
    async () => {
      const output = captureStdout()

      try {
        const started = await promptReceiver({ openBrowser: false, message: () => '' }).start({
          provider,
        })

        await started.present('https://provider.test/authorize')
        const pending = started.wait()
        process.stdin.push('nothing parseable\n')

        await expect(pending).rejects.toMatchObject({ code: 'invalid_token_response' })
        await started.close()
      } finally {
        output.restore()
      }
    },
    5_000,
  )
})
