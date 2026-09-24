import {
  mkdtemp,
  readdir,
  rm,
  stat,
  lstat,
  readFile,
  symlink,
  writeFile,
  mkdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fileStorage } from '../src/storage.js'

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

  it('does not lose writes across two instances over the same file', async () => {
    // `createNodeAuthClient` builds a fresh `fileStorage()` per client, so a
    // process signed in to two providers holds two adapters pointed at one
    // `auth.json`. A queue living on the instance serialises neither against
    // the other: both read the same base record and the second rename drops
    // the first's key, with both `set` calls resolving successfully.
    const openai = fileStorage({ dir })
    const claude = fileStorage({ dir })

    await Promise.all([
      openai.set('tokens:openai', '{"accessToken":"openai"}'),
      claude.set('tokens:claude', '{"accessToken":"claude"}'),
    ])

    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({
      'tokens:openai': '{"accessToken":"openai"}',
      'tokens:claude': '{"accessToken":"claude"}',
    })
  })

  it('shares one chain between a relative and an absolute dir', async () => {
    // The chain is keyed on the resolved path, so `--auth-dir ./creds` and the
    // absolute path it denotes are one file as far as serialisation goes.
    const asRelative = relative(process.cwd(), dir)
    const absolute = fileStorage({ dir })
    const viaRelative = fileStorage({ dir: asRelative })

    await Promise.all([absolute.set('a', '1'), viaRelative.set('b', '2')])

    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({ a: '1', b: '2' })
  })

  it('removes the temp file when the write fails part-way', async () => {
    // A failure below `EEXIST` — `ENOSPC`, `EIO`, a quota refusal — used to
    // rethrow with the temp file still on disk, holding every provider's
    // access *and* refresh tokens in plaintext. Nothing swept it afterwards:
    // the name is random, so no later write reuses it, and `logout` only
    // rewrites `auth.json`.
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()

      return {
        ...actual,
        writeFile: async (file: string, _data: string, options: { mode: number; flag: string }) => {
          /* Create the inode the way the real call would, then fail mid-write. */
          await actual.writeFile(file, '', options)
          const error = new Error('no space left on device') as NodeJS.ErrnoException
          error.code = 'ENOSPC'

          throw error
        },
      }
    })

    try {
      const { fileStorage: withFailingWrite } = await import('../src/storage.js')

      await expect(withFailingWrite({ dir }).set('tokens:openai', '{"refreshToken":"secret"}'))
        .rejects.toThrow(/no space left/)
      expect((await readdir(dir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('leaves a planted temp file alone instead of clearing the way for it', async () => {
    // The unlink above must not run on `EEXIST`. That file is not ours — it is
    // exactly the symlink `O_EXCL` just refused to follow — and removing it
    // would hand the attacker the retry they were denied.
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
      const planted = join(store, 'auth.json.deadbeefcafebabe.tmp')
      await symlink(decoy, planted)

      await expect(
        withPinnedSuffix({ dir: store }).set('tokens:openai', '{"accessToken":"secret"}'),
      ).rejects.toThrow(/Refusing to overwrite/)
      expect((await lstat(planted)).isSymbolicLink()).toBe(true)
    } finally {
      vi.doUnmock('node:crypto')
      vi.resetModules()
    }
  })

  it('moves a corrupt file aside instead of wiping every other provider', async () => {
    await mkdir(dir, { recursive: true })
    const survivors = {
      'tokens:openai': '{"refreshToken":"openai"}',
      'tokens:claude': '{"refreshToken":"claude"}',
      'tokens:gemini': '{"refreshToken":"gemini"}',
    }
    // A truncated record: three providers' refresh tokens, and one byte of the
    // file lost — the shape a crash or a full disk leaves behind. `readAll`
    // mapped that to `{}`, and because `set` rewrites the whole file from what
    // `readAll` returned, the next sign-in to a fourth provider silently
    // deleted the other three.
    const truncated = JSON.stringify(survivors, null, 2).slice(0, -1)
    await writeFile(join(dir, 'auth.json'), truncated)

    const storage = fileStorage({ dir })
    await storage.set('tokens:xai', '{"refreshToken":"xai"}')

    /* Login did not wedge, and the new provider is stored. */
    expect(await storage.get('tokens:xai')).toBe('{"refreshToken":"xai"}')

    const salvaged = (await readdir(dir)).filter((entry) => entry.includes('.corrupt-'))
    expect(salvaged).toHaveLength(1)
    expect(await readFile(join(dir, salvaged[0]!), 'utf8')).toBe(truncated)
    /* The moved-aside name is not one the adapter ever reads back as the record. */
    expect(salvaged[0]).not.toBe('auth.json')
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
