import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { defineProvider } from '@ai-oauth-sdk/core'

import { hybridReceiver } from '../src/hybrid.js'

const provider = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  /** Port 0 so the test never collides with a real service. */
  redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/callback' },
})

const silent = { openBrowser: false, message: () => '' }

let squatter: Server | undefined

afterEach(async () => {
  if (squatter) {
    await new Promise<void>((resolve) => squatter!.close(() => resolve()))
    squatter = undefined
  }
})

describe('hybridReceiver', () => {
  /*
   * `--paste` used to leave the loopback port unbound, so a local browser hit
   * "This site can't be reached" and the user had to read the address bar.
   */
  it('completes from the redirect without anything being pasted', async () => {
    const started = await hybridReceiver(silent).start({ provider })

    try {
      await started.present('https://provider.test/authorize')

      const response = await fetch(`${started.redirectUri}?code=abc&state=xyz`)
      expect(response.status).toBe(200)

      await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'xyz' })
    } finally {
      await started.close()
    }
  })

  it('advertises one redirect URI, since the token exchange replays it', async () => {
    const started = await hybridReceiver(silent).start({ provider })

    try {
      /* Bound to an ephemeral port, so the URI is only knowable after start(). */
      expect(started.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
      expect(started.redirectUri).not.toContain(':0/')
    } finally {
      await started.close()
    }
  })

  /*
   * A blank line on stdin rejects the paste half. Letting that rejection win
   * the race tore down a server that was about to receive a good callback, and
   * burned the authorization code with it.
   */
  it('ignores a failed paste and still completes from the redirect', async () => {
    const started = await hybridReceiver({
      ...silent,
      message: () => '',
    }).start({ provider })

    try {
      await started.present('https://provider.test/authorize')

      const pending = started.wait()
      process.stdin.push('\n')

      await new Promise((resolve) => setTimeout(resolve, 50))
      await fetch(`${started.redirectUri}?code=late&state=s`)

      await expect(pending).resolves.toEqual({ code: 'late', state: 's' })
    } finally {
      await started.close()
    }
  })

  /*
   * Binding fails when the port is held or the sandbox forbids listen() —
   * exactly the conditions --paste exists for, so it must not end the login.
   */
  it('falls back to pasting when the port cannot be bound', async () => {
    squatter = createServer(() => {})
    await new Promise<void>((resolve) => squatter!.listen(0, '127.0.0.1', () => resolve()))
    const held = (squatter.address() as { port: number }).port

    const fixedPort = defineProvider({
      ...provider,
      redirect: { mode: 'loopback', loopbackPort: held, loopbackPath: '/callback' },
    })

    const started = await hybridReceiver({ ...silent, port: held }).start({ provider: fixedPort })

    try {
      expect(started.redirectUri).toContain('/callback')
    } finally {
      await started.close()
    }
  })
})
