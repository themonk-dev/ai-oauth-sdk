import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { providers } from '@ai-oauth-sdk/core'

import { defaultReceiver } from '../src/index.js'

/**
 * Every variable `defaultReceiver` reads, directly or through
 * `canOpenBrowser()`.
 *
 * They are saved and put back around each test because vitest runs several test
 * files in one worker process: a `DISPLAY` left behind here would silently
 * change what an unrelated suite sees. `AI_OAUTH_SDK_NO_BROWSER` matters most
 * of all — the shared setup file sets it so nothing in the suite spawns the
 * machine's URL handler, and the desktop cases below have to lift it to be
 * about anything.
 */
const environmentKeys = [
  'AI_OAUTH_SDK_NO_BROWSER',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'SSH_TTY',
  'SSH_CONNECTION',
] as const

const saved = new Map<string, string | undefined>()

const setEnvironment = (values: Partial<Record<(typeof environmentKeys)[number], string>>) => {
  for (const key of environmentKeys) {
    const value = values[key]

    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

/** A machine with a browser on it: a display, and no SSH session. */
const desktop = () => setEnvironment({ DISPLAY: ':0' })

/** The same machine, reached over SSH — the browser is on the other end. */
const overSsh = () => setEnvironment({ DISPLAY: ':0', SSH_TTY: '/dev/pts/3' })

/** A box with no display at all: a container, a CI runner, a server. */
const noDisplay = () => setEnvironment({})

/**
 * `canOpenBrowser()` short-circuits to `true` on macOS and Windows, so the
 * display half of "headless" only ever decides anything on Linux. Skipping
 * rather than asserting elsewhere keeps that from being a test which passes by
 * measuring nothing.
 */
const displayDecidesHeadless = process.platform === 'linux'

/**
 * The three registry facts the receiver choice turns on, pinned here so a
 * change to a provider descriptor fails next to the reasoning it invalidates
 * rather than somewhere downstream.
 */
const loopbackWithoutHostedUri = [
  providers.openai,
  providers.gemini,
  providers.xai,
  providers.openrouter,
]

beforeEach(() => {
  for (const key of environmentKeys) {
    saved.set(key, process.env[key])
  }
})

afterEach(() => {
  for (const key of environmentKeys) {
    const value = saved.get(key)

    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('defaultReceiver', () => {
  it('describes the registry it is choosing over', () => {
    for (const provider of loopbackWithoutHostedUri) {
      expect(provider.redirect.mode, provider.id).toBe('loopback')
      expect(provider.redirect.hostedUri, provider.id).toBeUndefined()
    }

    // Claude is the only bundled provider with a page that displays the code,
    // which is why it is the only one that can paste without a fallback.
    expect(providers.claude.redirect.mode).toBe('loopback')
    expect(providers.claude.redirect.hostedUri).toBeTruthy()

    // And these two have no redirect at all — device flow only.
    expect(providers['github-copilot'].redirect.mode).toBe('custom')
    expect(providers.qwen.redirect.mode).toBe('custom')
  })

  describe('on a desktop', () => {
    beforeEach(desktop)

    it('catches the redirect locally for a loopback provider', () => {
      for (const provider of loopbackWithoutHostedUri) {
        expect(defaultReceiver(provider).id, provider.id).toBe('loopback')
      }
    })

    it('prefers loopback for a provider that also publishes a hosted page', () => {
      // Claude supports both; locally the server is strictly nicer than asking
      // the user to copy a code out of a web page.
      expect(defaultReceiver(providers.claude).id).toBe('loopback')
    })
  })

  describe('over SSH', () => {
    beforeEach(overSsh)

    it('offers paste alongside the port for a loopback provider', () => {
      // The regression: a bare loopback server here binds a port on the *remote*
      // box while the browser redirects to the laptop's own `localhost:1455`,
      // where nothing of ours is listening — so the login waits out `timeoutMs`
      // or hangs indefinitely. The hybrid keeps the port (a container with host
      // networking still completes untouched) and adds the prompt the user on
      // the other end of the connection actually needs.
      for (const provider of loopbackWithoutHostedUri) {
        expect(defaultReceiver(provider).id, provider.id).toBe('loopback-or-paste')
      }
    })

    it('sends a provider with a hosted page to the prompt', () => {
      // Claude's hosted callback *shows* the code, so there is a better thing
      // to paste from than a browser error page and nothing to gain from
      // binding a port the redirect will not reach.
      expect(defaultReceiver(providers.claude).id).toBe('manual')
    })
  })

  describe('with no display', () => {
    beforeEach(noDisplay)

    it.skipIf(!displayDecidesHeadless)(
      'offers paste alongside the port for a loopback provider',
      () => {
        for (const provider of loopbackWithoutHostedUri) {
          expect(defaultReceiver(provider).id, provider.id).toBe('loopback-or-paste')
        }
      },
    )

    it.skipIf(!displayDecidesHeadless)('sends a provider with a hosted page to the prompt', () => {
      expect(defaultReceiver(providers.claude).id).toBe('manual')
    })
  })

  describe('a provider with no redirect at all', () => {
    it('takes the prompt on every machine, not a loopback server', () => {
      // `github-copilot` and `qwen` are device-flow only. A loopback server here
      // would bind a port and advertise a redirect URI the provider accepts no
      // registration for, and then wait for a callback nobody will ever send.
      for (const shape of [desktop, overSsh, noDisplay]) {
        shape()

        for (const provider of [providers['github-copilot'], providers.qwen]) {
          expect(defaultReceiver(provider).id, provider.id).toBe('manual')
        }
      }
    })

    it('refuses with an error naming the flow that does work', async () => {
      desktop()

      // The point of routing here rather than to loopback: `manualReceiver`
      // has a purpose-written refusal for a provider with no redirect, and it
      // arrives at `start()` — before anything is bound, printed or waited on.
      await expect(
        defaultReceiver(providers['github-copilot']).start({
          provider: providers['github-copilot'],
        }),
      ).rejects.toMatchObject({
        code: 'configuration_error',
        message: expect.stringMatching(/deviceLogin\(\)/),
      })
    })
  })
})
