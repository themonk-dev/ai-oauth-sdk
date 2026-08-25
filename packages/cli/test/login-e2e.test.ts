import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/index.js'
import {
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../core/test/helpers/fakeAuthServer.js'

let dir: string
let server: FakeAuthServer
let stdout: string[]
let stderr: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aioauth-cli-e2e-'))
  server = await startFakeAuthServer({ device: { pendingPolls: 1 } })
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))

    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))

    return true
  })
  startFakeBrowser()
})

afterEach(async () => {
  stopFakeBrowser()
  vi.restoreAllMocks()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

const out = () => stdout.join('')
const err = () => stderr.join('')

let browserTimer: ReturnType<typeof setInterval> | undefined
const followed = new Set<string>()

/**
 * Stands in for the user's browser: watches stderr for authorization URLs and
 * follows each one, which lands the redirect on the loopback listener.
 *
 * Tracks what it has already opened, because stderr accumulates across several
 * logins in one test and re-following a consumed URL would hang the next flow.
 */
function startFakeBrowser(): void {
  browserTimer = setInterval(() => {
    // `g` so a second login's URL is seen even with the first still in stderr.
    for (const match of err().matchAll(/(http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+)/g)) {
      const url = match[1]!

      if (followed.has(url)) {
        continue
      }

      followed.add(url)
      void fetch(url, { redirect: 'follow' }).catch(() => {})
    }
  }, 10)
  browserTimer.unref?.()
}

function stopFakeBrowser(): void {
  if (browserTimer) {
    clearInterval(browserTimer)
  }

  browserTimer = undefined
  followed.clear()
}

const customFlags = (target: FakeAuthServer, extra: string[] = []) => [
  '--auth-dir',
  dir,
  '--client-id',
  'cli-test-client',
  '--authorize-url',
  `${target.url}/authorize`,
  '--token-url',
  `${target.url}/token`,
  ...extra,
]

describe('ai-oauth-sdk login — full loopback flow through the CLI', () => {
  it('signs in, stores the token, and reports the account', async () => {

    const code = await run([
      'login',
      'acme',
      ...customFlags(server, ['--port', '0', '--json']),
    ])

    expect(code).toBe(0)
    expect(JSON.parse(out())).toMatchObject({ provider: 'acme', hasRefreshToken: true })

    // The token really landed on disk, at 0600, in the shared auth.json.
    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    const tokens = JSON.parse(stored['tokens:acme']!) as { accessToken: string }
    expect(tokens.accessToken).toBe('access-1')

    // The exchange was a real PKCE exchange, verified by the server.
    expect(server.requests[0]?.['code_verifier']).toBeTruthy()
    expect(server.requests[0]?.['grant_type']).toBe('authorization_code')
  })

  it('makes the token available to the token command afterwards', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])

    stdout = []
    expect(await run(['token', 'acme', '--auth-dir', dir])).toBe(0)
    expect(out()).toBe('access-1\n')
  })

  it('shows the session in list', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])

    stdout = []
    expect(await run(['list', '--auth-dir', dir, '--json'])).toBe(0)
    expect(JSON.parse(out())).toMatchObject([{ provider: 'acme' }])
  })

  it('keeps two accounts separate', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0', '--account', 'work'])])
    await run(['login', 'acme', ...customFlags(server, ['--port', '0', '--account', 'home'])])

    stdout = []
    await run(['list', '--auth-dir', dir, '--json'])
    const sessions = JSON.parse(out()) as Array<{ account?: string }>
    expect(sessions.map((s) => s.account).sort()).toEqual(['home', 'work'])
  })

  it('refreshes on demand', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])

    stdout = []
    expect(await run(['refresh', 'acme', ...customFlags(server)])).toBe(0)
    expect(server.refreshCount).toBe(1)
  })

  it('runs exec with the freshly acquired token', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])

    const code = await run([
      'exec',
      'acme',
      '--auth-dir',
      dir,
      '--',
      'node',
      '-e',
      'process.exit(process.env.AI_OAUTH_SDK_TOKEN === "access-1" ? 7 : 1)',
    ])
    expect(code).toBe(7)
  })
})

describe('ai-oauth-sdk login --device', () => {
  it('prints the user code and completes when approved', async () => {
    const code = await run([
      'login',
      'acme',
      ...customFlags(server, ['--device', '--device-url', `${server.url}/device/code`]),
    ])

    expect(code).toBe(0)
    expect(err()).toContain('WXYZ-1234')
    expect(err()).toContain('example.test/device')

    stdout = []
    await run(['token', 'acme', '--auth-dir', dir])
    expect(out().trim()).toBe('access-1')
  })
})

describe('custom provider bookkeeping', () => {
  it('remembers the descriptor so later commands resolve the id', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])

    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    expect(stored['provider:acme']).toBeTruthy()

    // No endpoint flags this time — it has to come from the saved descriptor.
    stdout = []
    expect(await run(['whoami', 'acme', '--auth-dir', dir, '--json'])).toBe(0)
    expect(JSON.parse(out())).toMatchObject({ provider: 'acme' })
  })

  it('never writes the client secret into the credential file', async () => {
    await run([
      'login',
      'acme',
      ...customFlags(server, ['--port', '0', '--client-secret', 'SUPER-SECRET-VALUE']),
    ])

    const contents = await readFile(join(dir, 'auth.json'), 'utf8')
    // It was passed as a flag, so it is already in `ps` and shell history —
    // persisting it would turn that transient exposure into a durable one.
    expect(contents).not.toContain('SUPER-SECRET-VALUE')

    const stored = JSON.parse(contents) as Record<string, string>
    const descriptor = JSON.parse(stored['provider:acme']!) as Record<string, unknown>
    expect(descriptor['clientSecret']).toBeUndefined()
    // Everything else the descriptor exists for is still there.
    expect(descriptor['tokenUrl']).toBe(`${server.url}/token`)
  })

  it('reads the client secret from the environment', async () => {
    process.env['AI_OAUTH_SDK_CLIENT_SECRET'] = 'from-the-environment'

    try {
      const code = await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])
      expect(code).toBe(0)
      expect(server.requests[0]?.['client_secret']).toBe('from-the-environment')
    } finally {
      delete process.env['AI_OAUTH_SDK_CLIENT_SECRET']
    }
  })

  it('forgets the descriptor on logout', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])
    await run(['logout', 'acme', '--auth-dir', dir])

    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    // Logout should not leave the file dirtier than it found it.
    expect(stored['provider:acme']).toBeUndefined()
    expect(stored['tokens:acme']).toBeUndefined()
  })

  /**
   * The descriptor is shared by every account slot, so its lifetime is decided
   * by whether any session survives — not by whether `--account` was typed.
   *
   * `client.logout()` only ever clears its own account's record, so this
   * `logout` with no `--account` removes `tokens:acme` (which does not exist)
   * and leaves the named account alone. The guard used to read that missing
   * flag as "nothing else is stored" and delete `provider:acme` anyway, which
   * stranded a live refresh token: `list` still showed the session, while
   * `token` and even `logout --account work` could no longer resolve the id.
   */
  it('keeps the descriptor when an unnamed logout leaves a named session behind', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0', '--account', 'work'])])
    await run(['logout', 'acme', '--auth-dir', dir])

    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    expect(stored['tokens:acme:work']).toBeTruthy()
    expect(stored['provider:acme']).toBeTruthy()

    // The surviving session is still usable, which is what the descriptor is for.
    stdout = []
    expect(await run(['token', 'acme', '--auth-dir', dir, '--account', 'work'])).toBe(0)
    expect(out()).toBe('access-1\n')
  })

  // The mirror image of the same bug: passing `--account` used to keep the
  // descriptor unconditionally, so signing out of the last session left
  // `provider:acme` behind forever with nothing referring to it.
  it('forgets the descriptor when the last named account signs out', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0', '--account', 'work'])])
    await run(['logout', 'acme', '--auth-dir', dir, '--account', 'work'])

    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    expect(stored['tokens:acme:work']).toBeUndefined()
    expect(stored['provider:acme']).toBeUndefined()
  })

  it('keeps the descriptor when only one account signs out', async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0', '--account', 'work'])])
    await run(['login', 'acme', ...customFlags(server, ['--port', '0', '--account', 'home'])])
    await run(['logout', 'acme', '--auth-dir', dir, '--account', 'work'])

    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    // The other account still needs it.
    expect(stored['provider:acme']).toBeTruthy()
    expect(stored['tokens:acme:home']).toBeTruthy()
    expect(stored['tokens:acme:work']).toBeUndefined()
  })
})

describe('custom provider validation', () => {
  it('requires both endpoint flags together', async () => {
    expect(
      await run(['login', 'acme', '--auth-dir', dir, '--authorize-url', 'https://a.test/auth']),
    ).toBe(1)
    expect(err()).toContain('must be given together')
  })

  /**
   * The endpoint flags used to build a synthetic descriptor for *any* id,
   * including a built-in one. The descriptor kept `id: providerId`, so the
   * endpoints came from the flags while the credentials kept coming from the
   * built-in: the stored tokens under `tokens:gemini`, plus Google's published
   * client id and secret. Pointing a built-in at a staging or proxy endpoint
   * therefore shipped a live production refresh token there and exited 0.
   */
  describe('a built-in id with endpoint overrides', () => {
    const seedGemini = () =>
      writeFile(
        join(dir, 'auth.json'),
        JSON.stringify({
          'tokens:gemini': JSON.stringify({
            accessToken: 'VICTIM-ACCESS-TOKEN',
            refreshToken: 'VICTIM-REFRESH-TOKEN',
            tokenType: 'Bearer',
            provider: 'gemini',
            // Already expired, so `token` would reach for the refresh endpoint
            // even without --force-refresh.
            expiresAt: Date.now() - 60_000,
            raw: {},
          }),
        }),
      )

    const storedGemini = async () => {
      const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>

      return JSON.parse(stored['tokens:gemini']!) as { refreshToken?: string }
    }

    // A function, not a constant: `dir` and `server` are only assigned in
    // beforeEach, which runs after this describe body.
    const overrides = () => [
      '--auth-dir',
      dir,
      '--authorize-url',
      `${server.url}/authorize`,
      '--token-url',
      `${server.url}/token`,
    ]

    it('refuses login rather than aiming the built-in at another endpoint', async () => {
      expect(await run(['login', 'gemini', ...overrides()])).toBe(1)
      expect(err()).toContain('built-in provider')
      expect(err()).toContain('gemini')
      // The half that matters: nothing was sent to the endpoint that was named.
      expect(server.requests).toHaveLength(0)
    })

    it('refuses token --force-refresh, and the stored credential is untouched', async () => {
      await seedGemini()

      expect(await run(['token', 'gemini', '--force-refresh', ...overrides()])).toBe(1)
      expect(err()).toContain('built-in provider')
      expect(server.requests).toHaveLength(0)
      expect(server.refreshCount).toBe(0)
      expect((await storedGemini()).refreshToken).toBe('VICTIM-REFRESH-TOKEN')
      expect(out()).toBe('')
    })

    // Same path without the flag: the stored token is expired, so the refresh
    // happens on its own.
    it('refuses token with an expired stored credential too', async () => {
      await seedGemini()

      expect(await run(['token', 'gemini', ...overrides()])).toBe(1)
      expect(server.requests).toHaveLength(0)
      expect((await storedGemini()).refreshToken).toBe('VICTIM-REFRESH-TOKEN')
    })

    it('leaves the built-in alone when no endpoint flags are given', async () => {
      await writeFile(
        join(dir, 'auth.json'),
        JSON.stringify({
          'tokens:gemini': JSON.stringify({
            accessToken: 'still-valid',
            tokenType: 'Bearer',
            provider: 'gemini',
            expiresAt: Date.now() + 3_600_000,
            raw: {},
          }),
        }),
      )

      expect(await run(['token', 'gemini', '--auth-dir', dir])).toBe(0)
      expect(out()).toBe('still-valid\n')
    })
  })

  /**
   * `providers` and `publicClientIds` are plain object literals, so a bare
   * membership test or index read walks `Object.prototype`. An id is whatever
   * the user typed, and `constructor` is a thing people type: it was reported
   * as a built-in it is not, and `publicClientIds['constructor']` handed back
   * the `Object` *function* where the signature says `string`.
   */
  describe('an id that collides with Object.prototype', () => {
    it('is not mistaken for a built-in, and has no published client id', async () => {
      expect(
        await run([
          'login',
          'constructor',
          '--auth-dir',
          dir,
          '--authorize-url',
          `${server.url}/authorize`,
          '--token-url',
          `${server.url}/token`,
        ]),
      ).toBe(1)
      // The credential is missing, which is the honest complaint. Refusing it
      // as a "built-in provider", or silently signing in as `Object`, is not.
      expect(err()).toContain('--client-id')
      expect(err()).not.toContain('built-in provider')
    })

    it('signs in as the ordinary custom provider it is', async () => {
      expect(await run(['login', 'constructor', ...customFlags(server, ['--port', '0'])])).toBe(0)
      expect(server.requests[0]?.['client_id']).toBe('cli-test-client')

      const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
      expect(stored['tokens:constructor']).toBeTruthy()
      expect(stored['provider:constructor']).toBeTruthy()
    })
  })

  it('reports a token endpoint that rejects the exchange', async () => {
    const failing = await startFakeAuthServer({ failWith: 'invalid_grant' })

    try {
        const code = await run(['login', 'acme', ...customFlags(failing, ['--port', '0'])])
      expect(code).toBe(1)
      expect(err()).toContain('token_request_failed')
    } finally {
      await failing.close()
    }
  })
})
