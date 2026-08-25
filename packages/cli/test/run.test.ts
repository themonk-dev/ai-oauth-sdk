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

  // Every spelling, because the exit code alone cannot tell these apart: help
  // and version both exit 0, so only the output distinguishes them. `-v` used
  // to print help, since the help branch matched on "no command" first.
  it.each([['version'], ['-v'], ['--version']])('prints a version for %s', async (flag) => {
    expect(await run([flag])).toBe(0)
    expect(err().trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(err()).not.toContain('COMMANDS')
  })

  it('prints a version when a command is also present', async () => {
    expect(await run(['login', '--version'])).toBe(0)
    expect(err().trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects an unknown command', async () => {
    expect(await run(['frobnicate'])).toBe(1)
    expect(err()).toContain('Unknown command')
  })

  // The handler table is a plain object literal, so a bare `HANDLERS[command]`
  // read reached `Object.prototype`. `constructor` and `toString` are truthy
  // *and* callable, so the unknown-command branch was skipped, the inherited
  // member was invoked as a handler, and `run` returned 0 having printed
  // nothing at all — neither the error nor the help text. `valueOf` and
  // `__proto__` did exit 1, but on an internal JS error ("Cannot convert
  // undefined or null to object", "handler is not a function") rather than the
  // message a user can act on. `frobnicate` rides along as the control: every
  // one of these is a name that is not a command, so every one gets the same
  // answer.
  it.each([['frobnicate'], ['constructor'], ['toString'], ['valueOf'], ['__proto__']])(
    'rejects %s the same way, rather than reaching Object.prototype',
    async (command) => {
      expect(await run([command])).toBe(1)
      expect(err()).toContain(`Unknown command "${command}"`)
      expect(err()).toContain('ai-oauth-sdk help')
      expect(out()).toBe('')
    },
  )

  // `--json` routes machine-readable output to stdout, so an inherited member
  // being called as a handler could also corrupt a pipeline, not just exit 0.
  it('rejects an inherited name with --json too', async () => {
    expect(await run(['constructor', '--json'])).toBe(1)
    expect(out()).toBe('')
  })

  it('rejects an unknown option given without a command', async () => {
    expect(await run(['--nope'])).toBe(1)
    expect(err()).toContain('Unknown option')
  })

  it('reports an unknown command ahead of an unknown option', async () => {
    expect(await run(['frobnicate', '--nope'])).toBe(1)
    expect(err()).toContain('Unknown command')
  })

  it('exits 1 for a known flag with no command to apply it to', async () => {
    expect(await run(['--json'])).toBe(1)
    expect(err()).toContain('COMMANDS')
  })

  it('names every documented command in the help text', async () => {
    await run(['help'])

    for (const command of ['login', 'token', 'whoami', 'list', 'refresh', 'logout', 'providers', 'exec', 'version']) {
      expect(err(), command).toContain(command)
    }
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

  // The provider maps are plain object literals too, so an inherited name used
  // to resolve to something truthy the whole way through: `logout constructor`
  // reported "✓ Signed out of undefined." and exited 0, a success report for a
  // provider that has never existed.
  it.each([['constructor'], ['toString'], ['valueOf']])(
    'refuses to report success for %s',
    async (providerId) => {
      expect(await run(['logout', providerId, '--auth-dir', dir])).toBe(1)
      expect(err()).not.toContain('Signed out')
      expect(err()).not.toContain('undefined')
    },
  )
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
