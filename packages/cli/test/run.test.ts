import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/index.js'

let dir: string
let stdout: string[]
let stderr: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aioauth-cli-'))
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
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const out = () => stdout.join('')
const err = () => stderr.join('')

/** Writes a credential file directly, standing in for a completed login. */
async function seedSession(
  key: string,
  tokens: Record<string, unknown>,
  existing: Record<string, string> = {},
) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({ ...existing, [key]: JSON.stringify(tokens) }),
  )
}

describe('help and version', () => {
  it('prints help with no arguments and exits 0', async () => {
    expect(await run([])).toBe(0)
    expect(err()).toContain('ai-oauth-sdk')
    expect(err()).toContain('COMMANDS')
  })

  it('prints help for the help command', async () => {
    expect(await run(['help'])).toBe(0)
    expect(err()).toContain('USAGE')
  })

  it('prints a version', async () => {
    expect(await run(['version'])).toBe(0)
    expect(err().trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects an unknown command', async () => {
    expect(await run(['frobnicate'])).toBe(1)
    expect(err()).toContain('Unknown command')
  })
})

describe('providers', () => {
  it('lists providers as a table', async () => {
    expect(await run(['providers'])).toBe(0)
    expect(err()).toContain('openai')
    expect(err()).toContain('claude')
    expect(err()).toContain('github-copilot')
  })

  it('lists providers as JSON on stdout', async () => {
    expect(await run(['providers', '--json'])).toBe(0)
    const parsed = JSON.parse(out()) as Array<{ id: string; flow: string }>
    expect(parsed.some((p) => p.id === 'openai')).toBe(true)
    // Device-only providers are reported as such.
    expect(parsed.find((p) => p.id === 'github-copilot')?.flow).toBe('device')
  })
})

describe('argument validation', () => {
  it('requires a provider for login', async () => {
    expect(await run(['login'])).toBe(1)
    expect(err()).toContain('Missing provider')
  })

  it('requires a provider for token', async () => {
    expect(await run(['token'])).toBe(1)
    expect(err()).toContain('Missing provider')
  })

  it('rejects an unknown provider with the known list', async () => {
    expect(await run(['login', 'notreal', '--auth-dir', dir])).toBe(1)
    expect(err()).toContain('Unknown provider')
  })

  // xai and google used to have no published id, so the CLI could only tell
  // you to pass one. Both now default to the vendor's, which means `login`
  // proceeds to a real flow instead of failing — so the thing worth asserting
  // is that a provider we have no credential for still explains itself.
  it('asks for a client id when the provider has none', async () => {
    expect(
      await run([
        'login',
        'acme',
        '--authorize-url',
        'https://acme.test/authorize',
        '--token-url',
        'https://acme.test/token',
        '--auth-dir',
        dir,
      ]),
    ).toBe(1)
    expect(err()).toContain('--client-id')
  })
})

describe('flags that are not real', () => {
  // Every mode is named against loopback, so people reach for --loopback — and
  // it used to parse, get ignored, and run the default as though nothing had
  // been passed.
  it('rejects an unknown option instead of ignoring it', async () => {
    expect(await run(['login', 'openai', '--loopback', '--auth-dir', dir])).toBe(1)
    expect(err()).toContain('Unknown option "--loopback"')
    expect(err()).toContain('loopback is the default')
  })

  // The device-only branch short-circuits past the receiver, so this guard used
  // to be unreachable and --paste silently ran a device login.
  it('refuses --paste on a provider with no redirect', async () => {
    expect(await run(['login', 'github-copilot', '--paste', '--auth-dir', dir])).toBe(1)
    expect(err()).toContain('--paste cannot complete it')
  })
})

describe('list', () => {
  it('reports an empty store', async () => {
    expect(await run(['list', '--auth-dir', dir])).toBe(0)
    expect(err()).toContain('No stored sessions')
  })

  it('returns an empty JSON array for an empty store', async () => {
    expect(await run(['list', '--auth-dir', dir, '--json'])).toBe(0)
    expect(JSON.parse(out())).toEqual([])
  })

  it('lists a stored session', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      email: 'dev@example.com',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    expect(await run(['list', '--auth-dir', dir])).toBe(0)
    expect(err()).toContain('openai')
    expect(err()).toContain('dev@example.com')
  })

  it('distinguishes named accounts', async () => {
    await seedSession('tokens:claude:work', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'claude',
      email: 'work@example.com',
      raw: {},
    })

    expect(await run(['list', '--auth-dir', dir, '--json'])).toBe(0)
    const parsed = JSON.parse(out()) as Array<{ provider: string; account?: string }>
    expect(parsed[0]?.provider).toBe('claude')
    expect(parsed[0]?.account).toBe('work')
  })
})

describe('whoami', () => {
  it('fails helpfully when not signed in', async () => {
    expect(await run(['whoami', 'openai', '--auth-dir', dir])).toBe(1)
    expect(err()).toContain('Not signed in')
    expect(err()).toContain('ai-oauth-sdk login openai')
  })

  it('reports the stored account', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      email: 'dev@example.com',
      scope: 'openid profile',
      refreshToken: 'r',
      raw: {},
    })

    expect(await run(['whoami', 'openai', '--auth-dir', dir])).toBe(0)
    expect(err()).toContain('dev@example.com')
    expect(err()).toContain('openid profile')
  })

  it('emits JSON on stdout', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      accountId: 'acct-1',
      raw: {},
    })

    expect(await run(['whoami', 'openai', '--auth-dir', dir, '--json'])).toBe(0)
    expect(JSON.parse(out())).toMatchObject({ provider: 'openai', accountId: 'acct-1' })
  })
})

describe('token', () => {
  it('prints the bare token on stdout, nothing else', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'sk-test-123',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    expect(await run(['token', 'openai', '--auth-dir', dir])).toBe(0)
    // Must be exactly the token: this output gets captured by $(...).
    expect(out()).toBe('sk-test-123\n')
  })

  it('tells the user to sign in when there is no session', async () => {
    expect(await run(['token', 'openai', '--auth-dir', dir])).toBe(1)
    expect(err()).toContain('ai-oauth-sdk login openai')
    expect(out()).toBe('')
  })
})

describe('logout', () => {
  it('clears a stored session', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      raw: {},
    })

    expect(await run(['logout', 'openai', '--auth-dir', dir])).toBe(0)
    expect(err()).toContain('Signed out')

    stdout = []
    expect(await run(['list', '--auth-dir', dir, '--json'])).toBe(0)
    expect(JSON.parse(out())).toEqual([])
  })

  it('warns when the provider cannot revoke', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      raw: {},
    })

    expect(await run(['logout', 'openai', '--auth-dir', dir, '--revoke'])).toBe(0)
    expect(err()).toContain('no revocation endpoint')
  })

  it('is safe to run when not signed in', async () => {
    expect(await run(['logout', 'openai', '--auth-dir', dir])).toBe(0)
  })
})

describe('exec', () => {
  it('requires a command after --', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    expect(await run(['exec', 'openai', '--auth-dir', dir])).toBe(1)
    expect(err()).toContain('No command to run')
  })

  it('injects the token and propagates the exit code', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'sk-exec-token',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    // The child inherits stdio, so assert via its exit code rather than output.
    const code = await run([
      'exec',
      'openai',
      '--auth-dir',
      dir,
      '--',
      'node',
      '-e',
      'process.exit(process.env.AI_OAUTH_SDK_TOKEN === "sk-exec-token" ? 7 : 1)',
    ])
    expect(code).toBe(7)
  })

  it('reports a signalled child the way a shell does', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    const code = await run([
      'exec',
      'openai',
      '--auth-dir',
      dir,
      '--',
      'node',
      '-e',
      'process.kill(process.pid, "SIGTERM")',
    ])
    // 128 + SIGTERM(15), so `ai-oauth-sdk exec … ; echo $?` matches running it directly.
    expect(code).toBe(143)
  })

  it('explains a command that does not exist', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'a',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    expect(
      await run(['exec', 'openai', '--auth-dir', dir, '--', 'definitely-not-a-real-binary']),
    ).toBe(1)
    expect(err()).toContain('Could not run')
    expect(err()).toContain('PATH')
  })

  it('honours a custom env var name', async () => {
    await seedSession('tokens:openai', {
      accessToken: 'sk-exec-token',
      tokenType: 'Bearer',
      provider: 'openai',
      expiresAt: Date.now() + 3_600_000,
      raw: {},
    })

    const code = await run([
      'exec',
      'openai',
      '--auth-dir',
      dir,
      '--env-var',
      'OPENAI_API_KEY',
      '--',
      'node',
      '-e',
      'process.exit(process.env.OPENAI_API_KEY === "sk-exec-token" ? 7 : 1)',
    ])
    expect(code).toBe(7)
  })
})
