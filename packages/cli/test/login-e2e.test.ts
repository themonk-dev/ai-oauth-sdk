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

/**
 * `logout --revoke --json` used to print `revoked: shouldRevoke` — what was
 * asked for, not what happened. The worse half is a provider that *does*
 * declare a revocation endpoint and whose endpoint refuses: the revocation is
 * genuinely attempted, `AuthClient.logout` swallows the failure so the user is
 * still signed out locally, and the CLI printed the same `revoked: true` a
 * success prints, with nothing on stderr. The field carried no information.
 */
describe('logout --revoke reports what the provider did', () => {
  /** Points the remembered descriptor at a revocation endpoint. */
  async function withRevocationUrl(revocationUrl: string): Promise<void> {
    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
    const descriptor = JSON.parse(stored['provider:acme']!) as Record<string, unknown>
    stored['provider:acme'] = JSON.stringify({ ...descriptor, revocationUrl })
    await writeFile(join(dir, 'auth.json'), JSON.stringify(stored))
  }

  beforeEach(async () => {
    await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])
    stdout = []
    stderr = []
  })

  it('reports revoked: true only when the provider actually took it', async () => {
    await withRevocationUrl(`${server.url}/revoke`)

    expect(await run(['logout', 'acme', '--auth-dir', dir, '--revoke', '--json'])).toBe(0)
    expect(JSON.parse(out())).toEqual({
      provider: 'acme',
      signedOut: true,
      revoked: true,
      revocation: 'revoked',
    })
    // The provider really was told, and about the refresh token.
    expect(server.revocations).toHaveLength(1)
    expect(server.revocations[0]?.['token']).toBe('refresh-1')
  })

  it('reports revoked: false, and warns, when the endpoint refuses', async () => {
    const refusing = await startFakeAuthServer({ revokeStatus: 503 })

    try {
      await withRevocationUrl(`${refusing.url}/revoke`)

      expect(await run(['logout', 'acme', '--auth-dir', dir, '--revoke', '--json'])).toBe(0)

      const parsed = JSON.parse(out()) as Record<string, unknown>
      expect(parsed).toMatchObject({
        provider: 'acme',
        signedOut: true,
        revoked: false,
        revocation: 'failed',
      })
      expect(parsed['revocationError']).toMatchObject({ code: 'token_request_failed' })

      // It was genuinely attempted — the endpoint refused it.
      expect(refusing.revocations).toHaveLength(1)
      // The absent-endpoint warning was the only signal there used to be; a
      // refusal has to speak too, since the local copy is gone either way.
      expect(err()).toContain('still live')

      const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>
      expect(stored['tokens:acme']).toBeUndefined()
    } finally {
      await refusing.close()
    }
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
   * The built-in guard above answers "is this id built-in", but what actually
   * matters is "does this id already hold a credential minted somewhere
   * known". A remembered custom provider does: `provider:acme` records the
   * endpoints, and `tokens:acme` the credential issued by them. The endpoint
   * flags rebuilt the descriptor around the same id and won outright, so
   * `refresh acme --token-url <other>` sent the stored production refresh token
   * to `<other>` and overwrote the stored tokens with its answer — exit 0, no
   * output on stderr at all. It takes nothing exotic to get there: a script or
   * a copied command line carrying the login flags forward with one host edited
   * to a staging box, a proxy, or a typo.
   */
  describe('a remembered custom provider with different endpoints', () => {
    let elsewhere: FakeAuthServer

    beforeEach(async () => {
      elsewhere = await startFakeAuthServer()
      await run(['login', 'acme', ...customFlags(server, ['--port', '0'])])
      stdout = []
      stderr = []
    })

    afterEach(async () => {
      await elsewhere.close()
    })

    const storedAcme = async () => {
      const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, string>

      return {
        tokens: JSON.parse(stored['tokens:acme']!) as { accessToken: string; refreshToken?: string },
        descriptor: JSON.parse(stored['provider:acme']!) as Record<string, string>,
      }
    }

    // The token URL is the one that receives the stored refresh token.
    const mixedFlags = (extra: string[] = []) => [
      '--auth-dir',
      dir,
      '--client-id',
      'cli-test-client',
      '--authorize-url',
      `${server.url}/authorize`,
      '--token-url',
      `${elsewhere.url}/token`,
      ...extra,
    ]

    it('refuses refresh, and the refresh token never leaves', async () => {
      expect(await run(['refresh', 'acme', ...mixedFlags()])).toBe(1)

      expect(err()).toContain('--token-url')
      expect(err()).toContain(`${elsewhere.url}/token`)
      expect(err()).toContain(`${server.url}/token`)

      // The half that matters: the other endpoint saw nothing at all.
      expect(elsewhere.requests).toEqual([])
      expect(elsewhere.refreshCount).toBe(0)

      // And the stored session is exactly as the real provider left it.
      const { tokens, descriptor } = await storedAcme()
      expect(tokens.refreshToken).toBe('refresh-1')
      expect(descriptor['tokenUrl']).toBe(`${server.url}/token`)
    })

    it('refuses token --force-refresh the same way', async () => {
      expect(await run(['token', 'acme', '--force-refresh', ...mixedFlags()])).toBe(1)

      expect(err()).toContain('--token-url')
      expect(elsewhere.requests).toEqual([])
      // No access token was printed for a caller to pipe onwards.
      expect(out()).toBe('')
      expect((await storedAcme()).tokens.refreshToken).toBe('refresh-1')
    })

    it('names the authorization endpoint when that is the one that differs', async () => {
      expect(
        await run([
          'whoami',
          'acme',
          '--auth-dir',
          dir,
          '--client-id',
          'cli-test-client',
          '--authorize-url',
          `${elsewhere.url}/authorize`,
          '--token-url',
          `${server.url}/token`,
        ]),
      ).toBe(1)

      expect(err()).toContain('--authorize-url')
      expect(err()).toContain('ai-oauth-sdk login acme')
    })

    it('still refreshes when the endpoints agree', async () => {
      expect(await run(['refresh', 'acme', ...customFlags(server)])).toBe(0)
      expect(server.refreshCount).toBe(1)
      expect(elsewhere.requests).toEqual([])
    })

    /**
     * Providers do move, so the change has to stay possible — just not by
     * accident with the old credential in hand. `login` mints a fresh one
     * against the new endpoints and re-remembers them, which makes it the
     * deliberate path the refusal points at.
     */
    it('lets login move the provider to the new endpoints', async () => {
      expect(await run(['login', 'acme', ...customFlags(elsewhere, ['--port', '0'])])).toBe(0)

      const { descriptor } = await storedAcme()
      expect(descriptor['tokenUrl']).toBe(`${elsewhere.url}/token`)

      // A fresh authorization-code exchange — the old refresh token was not
      // handed over as part of moving.
      expect(elsewhere.requests.map((body) => body['grant_type'])).toEqual(['authorization_code'])
      expect(elsewhere.requests[0]?.['refresh_token']).toBeUndefined()
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
