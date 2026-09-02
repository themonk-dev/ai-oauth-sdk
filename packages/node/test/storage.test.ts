import { mkdtemp, readdir, rm, stat, readFile, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
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

  it('deleting an absent key touches nothing on disk', async () => {
    // A no-op has to be a no-op all the way down: `delete` of a key that is not
    // there must not create the credential directory, because doing so makes it
    // throw `ENOENT ... mkdir` on a read-only home where it used to resolve
    // silently. `logout` calls this on providers that were never logged in.
    const store = join(dir, 'never-created')
    const storage = fileStorage({ dir: store })

    await expect(storage.delete('nothing')).resolves.toBeUndefined()
    expect(await stat(store).catch(() => null)).toBeNull()
  })

  // `set` and `delete` are read-modify-writes over the whole file, so anything
  // that can run two of them at once can lose a key. A queue per `fileStorage()`
  // instance only covers callers that share the instance — and nothing in this
  // SDK guarantees they do.
  describe('serialises writes to one file across every writer in this process', () => {
    it('does not lose writes between two instances over the same file', async () => {
      // The ordinary shape: `createNodeAuthClient` builds a fresh
      // `fileStorage()` per client, so one client per provider is already two
      // instances over one `auth.json`. Two concurrent refreshes then roll one
      // provider's rotated token back to the value it had before, which shows up
      // much later as an `invalid_grant` on a session that looked fine.
      const first = fileStorage({ dir })
      const second = fileStorage({ dir })

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0 ? first.set(`first-${i}`, String(i)) : second.set(`second-${i}`, String(i)),
        ),
      )

      const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
      expect(Object.keys(record)).toHaveLength(20)
    })

    it('shares one chain between instances spelling the directory differently', async () => {
      // The chain is keyed by the absolute path, so a caller that passes a
      // relative `dir` — `--dir ./creds` — lands on the same chain as one that
      // passed the absolute spelling of it. Keying by the raw option instead
      // gives them a chain each, and they lose each other's keys.
      const spelling = relative(process.cwd(), dir)
      // Guard the premise: if this ever came back absolute the two spellings
      // would be one, and the test would pass while pinning nothing.
      expect(isAbsolute(spelling)).toBe(false)

      const first = fileStorage({ dir })
      const second = fileStorage({ dir: spelling })

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? first.set(`absolute-${i}`, String(i))
            : second.set(`relative-${i}`, String(i)),
        ),
      )

      const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
      expect(Object.keys(record)).toHaveLength(20)
    })
  })

  it('keeps an absolute `file` inside `dir`', async () => {
    // `file` names a file in `dir`; it is not a second way to choose a path.
    // Resolving the two against each other lets `file` win outright, so a value
    // that reached this option from a config file or a flag could put the
    // token file anywhere on the disk the process can write.
    const store = join(dir, 'store')
    const escape = join(dir, 'escape.json')
    const storage = fileStorage({ dir: store, file: escape })

    await storage.set('k', 'v')

    // Nothing was written at the absolute path, and the record is inside the
    // store, under the absolute name taken as the relative one it is.
    expect(await stat(escape).catch(() => null)).toBeNull()
    expect(JSON.parse(await readFile(join(store, escape), 'utf8'))).toEqual({ k: 'v' })
  })
})
