import { mkdtemp, readdir, rm, stat, readFile, symlink, writeFile, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAuthDir, fileStorage } from '../src/storage.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aioauth-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('fileStorage', () => {
  it('round-trips values', async () => {
    const storage = fileStorage({ dir })
    expect(await storage.get('missing')).toBeNull()

    await storage.set('tokens:openai', '{"accessToken":"abc"}')
    expect(await storage.get('tokens:openai')).toBe('{"accessToken":"abc"}')

    await storage.delete('tokens:openai')
    expect(await storage.get('tokens:openai')).toBeNull()
  })

  it('writes the credential file as 0600', async () => {
    const storage = fileStorage({ dir })
    await storage.set('k', 'v')

    const stats = await stat(join(dir, 'auth.json'))
    // Other users on a shared box must not be able to read the tokens.
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('does not write the record through a symlink planted at the temp path', async () => {
    const store = join(dir, 'store')
    const decoy = join(dir, 'decoy')
    await mkdir(store, { recursive: true })
    await writeFile(decoy, 'attacker owned')
    // The temp file used to be named `auth.json.<pid>.tmp` and opened without
    // `O_EXCL`, so anyone who could write to the credential directory could
    // pre-place a symlink there and have every provider's tokens written into a
    // file they own. The pid is still predictable from inside this process,
    // which is what makes this a real reproduction rather than a smoke test.
    await symlink(decoy, join(store, `auth.json.${process.pid}.tmp`))

    const storage = fileStorage({ dir: store })
    await storage.set('tokens:openai', '{"accessToken":"secret"}')

    expect(await readFile(decoy, 'utf8')).toBe('attacker owned')
    // The random suffix makes the temp path unpredictable, so assert the
    // invariant instead: the write produced nothing outside the store.
    expect((await readdir(dir)).sort()).toEqual(['decoy', 'store'])
    expect(JSON.parse(await readFile(join(store, 'auth.json'), 'utf8'))).toEqual({
      'tokens:openai': '{"accessToken":"secret"}',
    })
  })

  it('refuses the write even when the temp name is predicted', async () => {
    // The test above passes on the random name alone: the planted symlink sits
    // where the old code would have written, which the new name never touches.
    // That leaves `O_EXCL` — the half that actually has to hold — uncovered, so
    // pin the suffix to a known value and let the attacker win the guess.
    const store = join(dir, 'store')
    const decoy = join(dir, 'decoy')
    await mkdir(store, { recursive: true })
    await writeFile(decoy, 'attacker owned')

    vi.resetModules()
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomBytes: () => Buffer.from('deadbeefcafebabe', 'hex'),
    }))

    try {
      const { fileStorage: withPinnedSuffix } = await import('../src/storage.js')
      await symlink(decoy, join(store, 'auth.json.deadbeefcafebabe.tmp'))

      await expect(
        withPinnedSuffix({ dir: store }).set('tokens:openai', '{"accessToken":"secret"}'),
      ).rejects.toThrow(/Refusing to overwrite/)
      expect(await readFile(decoy, 'utf8')).toBe('attacker owned')
    } finally {
      vi.doUnmock('node:crypto')
      vi.resetModules()
    }
  })

  it('keeps several keys in one file', async () => {
    const storage = fileStorage({ dir })
    await storage.set('a', '1')
    await storage.set('b', '2')

    expect(await storage.get('a')).toBe('1')
    expect(await storage.get('b')).toBe('2')
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({ a: '1', b: '2' })
  })

  it('does not lose writes under concurrency', async () => {
    const storage = fileStorage({ dir })
    // Ten unserialised read-modify-writes would clobber each other; the queue
    // is what makes this safe.
    await Promise.all(Array.from({ length: 10 }, (_, i) => storage.set(`key-${i}`, String(i))))

    const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    expect(Object.keys(record)).toHaveLength(10)

    for (let i = 0; i < 10; i++) {
      expect(record[`key-${i}`]).toBe(String(i))
    }
  })

  it('recovers from a corrupt file instead of wedging login', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), 'not json at all')

    const storage = fileStorage({ dir })
    expect(await storage.get('anything')).toBeNull()

    await storage.set('fresh', 'value')
    expect(await storage.get('fresh')).toBe('value')
  })

  it('creates nested directories on demand', async () => {
    const nested = join(dir, 'a', 'b', 'c')
    const storage = fileStorage({ dir: nested })
    await storage.set('k', 'v')
    expect(await storage.get('k')).toBe('v')
  })

  it('deleting an absent key is a no-op', async () => {
    const storage = fileStorage({ dir })
    await expect(storage.delete('nothing')).resolves.toBeUndefined()
  })
})

describe('defaultAuthDir', () => {
  const home = process.env['AI_OAUTH_SDK_HOME']

  afterEach(() => {
    if (home === undefined) {
      delete process.env['AI_OAUTH_SDK_HOME']
    } else {
      process.env['AI_OAUTH_SDK_HOME'] = home
    }
  })

  it('honours AI_OAUTH_SDK_HOME', () => {
    process.env['AI_OAUTH_SDK_HOME'] = dir
    expect(defaultAuthDir()).toBe(dir)
  })

  it('falls back to the home directory when the variable is set but blank', () => {
    // A Dockerfile's `ENV AI_OAUTH_SDK_HOME=`, or `export
    // AI_OAUTH_SDK_HOME="$SOMETHING_UNSET"` in CI, leaves it present and
    // empty. `??` carried that through as a relative path, so refresh tokens
    // landed in `./auth.json` in whatever the cwd happened to be.
    for (const blank of ['', '   ']) {
      process.env['AI_OAUTH_SDK_HOME'] = blank
      expect(defaultAuthDir()).toBe(join(homedir(), '.ai-oauth-sdk'))
    }
  })

  it('writes nothing to the working directory when the variable is blank', () => {
    process.env['AI_OAUTH_SDK_HOME'] = ''
    // The path is what decides where the credential file goes, and a relative
    // one puts it in a git working tree or a Docker build context.
    expect(isAbsolute(defaultAuthDir())).toBe(true)
  })
})
