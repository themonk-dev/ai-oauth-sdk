import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineProvider } from '@ai-oauth-sdk/core'

import { defaultReceiver } from '../src/index.js'

/** Port 0 so the test never collides with a real service. */
const loopbackOnly = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'c',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: [],
  redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/callback' },
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('defaultReceiver', () => {
  it('warns that the callback is served from this host when headless with no hosted page', async () => {
    // Every bundled provider except Claude publishes no hosted redirect page,
    // so a headless box falls through to loopback here. The receiver is right —
    // it is the only one that can complete the flow — but over SSH the
    // provider redirects the *laptop's* browser to the laptop's `localhost`,
    // and `login()` arms no deadline unless `timeoutMs` was passed. Without
    // this notice the command sits there forever having printed only a URL.
    vi.stubEnv('SSH_TTY', '/dev/pts/0')

    const receiver = defaultReceiver(loopbackOnly)
    expect(receiver.id).toBe('loopback')

    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))

      return true
    })

    const started = await receiver.start({ provider: loopbackOnly })

    try {
      await started.present('https://provider.test/authorize?state=s')
    } finally {
      await started.close()
    }

    const output = written.join('')
    expect(output).toContain('https://provider.test/authorize?state=s')
    /* Says the callback lands here, names the ways out, and names the timeout. */
    expect(output).toMatch(/headless/i)
    expect(output).toContain('this machine')
    expect(output).toContain('--paste')
    expect(output).toContain('deviceLogin')
    expect(output).toMatch(/timeoutMs/)
  })
})
