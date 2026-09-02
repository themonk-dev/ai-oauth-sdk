import { execFile } from 'node:child_process'
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  readFile,
  symlink,
  utimes,
  writeFile,
  mkdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fileStorage } from '../src/storage.js'

const run = promisify(execFile)

/** The adapter's own source, imported by the child processes spawned below. */
const storageModule = fileURLToPath(new URL('../src/storage.ts', import.meta.url))

/**
 * Whether this Node can run a TypeScript file directly.
 *
 * The cross-process cases below have to be *actual* processes — that is the
 * whole point of them — and the only way to put this adapter in one without a
 * build step is Node's own type stripping (unflagged since 22.18). Where it is
 * unavailable the in-process cases still cover the shared queue, and the lock
 * file is exercised by the planted-lock cases, which need no child at all.
 */
const canRunTypeScript = await (async () => {
  const probe = join(await mkdtemp(join(tmpdir(), 'aioauth-probe-')), 'probe.ts')

  try {
    await writeFile(probe, 'const ok: string = "ok"\nprocess.stdout.write(ok)\n')
    const { stdout } = await run(process.execPath, [probe])

    return stdout.trim() === 'ok'
  } catch {
    return false
  } finally {
    await rm(join(probe, '..'), { recursive: true, force: true })
  }
})()

/**
 * Writes `count` keys through a *separate OS process*, one `set` at a time.
 *
 * Two of these racing is two CLI windows racing, which `client.ts` treats as
 * ordinary. No promise chain can help here: the only thing standing between
 * them is the lock file.
 */
const writeFromChildProcess = async (
  storeDir: string,
  prefix: string,
  count: number,
): Promise<void> => {
  const script = join(storeDir, `${prefix}-writer.ts`)
  await writeFile(
    script,
    `import { fileStorage } from ${JSON.stringify(storageModule)}\n` +
      `const storage = fileStorage({ dir: ${JSON.stringify(storeDir)} })\n` +
      `for (let i = 0; i < ${count}; i++) {\n` +
      `  await storage.set(${JSON.stringify(prefix)} + i, String(i))\n` +
      `}\n`,
  )
  await run(process.execPath, [script])
}

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

  // `set` and `delete` are read-modify-writes over the whole file, so anything
  // that can run two of them at once can lose a key. A queue per `fileStorage()`
  // instance only covers callers that share the instance — and nothing in this
  // SDK guarantees they do.
  describe('serialises writes to one file across every writer', () => {
    it('does not lose writes between two instances over the same file', async () => {
      // The ordinary shape: `createNodeAuthClient` builds a fresh
      // `fileStorage()` per client, so one client per provider is already two
      // instances over one `auth.json`. Two concurrent refreshes then roll one
      // provider's rotated token back to the value it had before, which shows up
      // much later as an `invalid_grant` on a session that looked fine.
      const first = fileStorage({ dir })
      const second = fileStorage({ dir })

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          i % 2 === 0 ? first.set(`first-${i}`, String(i)) : second.set(`second-${i}`, String(i)),
        ),
      )

      const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
      expect(Object.keys(record)).toHaveLength(10)
    })

    it('serialises two instances even where the lock file excludes nothing', async () => {
      // The in-process chain and the lock file are not two spellings of one
      // fix. This pins the chain on its own: `open` is made to hand back a
      // handle unconditionally, the way an `O_EXCL` create that does not
      // actually exclude would (a network filesystem, a stubbed-out fs), so the
      // only thing left standing between the two instances is the shared queue.
      vi.resetModules()
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const real = await importOriginal<typeof import('node:fs/promises')>()

        return {
          ...real,
          default: real,
          open: () => Promise.resolve({ writeFile: async () => {}, close: async () => {} }),
        }
      })

      try {
        const { fileStorage: withoutExclusion } = await import('../src/storage.js')
        const first = withoutExclusion({ dir })
        const second = withoutExclusion({ dir })

        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            i % 2 === 0 ? first.set(`first-${i}`, String(i)) : second.set(`second-${i}`, String(i)),
          ),
        )

        const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
        expect(Object.keys(record)).toHaveLength(10)
      } finally {
        vi.doUnmock('node:fs/promises')
        vi.resetModules()
      }
    })

    it('shares one chain between instances spelling the path differently', async () => {
      const first = fileStorage({ dir })
      const second = fileStorage({ dir: join(dir, 'unused', '..') })

      await Promise.all([first.set('a', '1'), second.set('b', '2')])

      expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({
        a: '1',
        b: '2',
      })
    })

    it.skipIf(!canRunTypeScript)(
      'does not lose writes between two OS processes',
      async () => {
        // Two CLI windows. There is no shared promise chain to reach for, so
        // this is the lock file or nothing.
        await Promise.all([
          writeFromChildProcess(dir, 'alpha', 20),
          writeFromChildProcess(dir, 'beta', 20),
        ])

        const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
        expect(Object.keys(record).filter((key) => key.startsWith('alpha'))).toHaveLength(20)
        expect(Object.keys(record).filter((key) => key.startsWith('beta'))).toHaveLength(20)
      },
      30_000,
    )

    it('waits for a lock another process holds, then writes', async () => {
      await mkdir(dir, { recursive: true })
      const lockPath = join(dir, 'auth.json.lock')
      await writeFile(lockPath, 'another process')

      const storage = fileStorage({ dir })
      const pending = storage.set('k', 'v')
      let settled = false
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      )

      await new Promise((resolve) => setTimeout(resolve, 150))
      // Held by someone else: the read-modify-write has not started, so it
      // cannot be reading a record that is about to be replaced.
      expect(settled).toBe(false)
      expect(await stat(join(dir, 'auth.json')).catch(() => null)).toBeNull()

      await rm(lockPath)
      await expect(pending).resolves.toBeUndefined()
      expect(await storage.get('k')).toBe('v')
    })

    it('reclaims a lock whose owner died', async () => {
      // A crashed CLI must not wedge the credential store forever, so a lock
      // left untouched past the staleness threshold is taken rather than waited
      // on. The threshold is ten seconds; this one is aged a minute.
      await mkdir(dir, { recursive: true })
      const lockPath = join(dir, 'auth.json.lock')
      await writeFile(lockPath, 'a process that is no longer running')
      const aMinuteAgo = new Date(Date.now() - 60_000)
      await utimes(lockPath, aMinuteAgo, aMinuteAgo)

      const storage = fileStorage({ dir })
      await expect(storage.set('k', 'v')).resolves.toBeUndefined()
      expect(await storage.get('k')).toBe('v')
      // And the store is left clean for the next writer.
      expect(await stat(lockPath).catch(() => null)).toBeNull()
    })

    it('surfaces a lock that cannot be taken instead of writing anyway', async () => {
      // Writing without the lock is exactly the data loss the lock exists to
      // prevent, so an acquisition failure has to reach the caller.
      vi.resetModules()
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const real = await importOriginal<typeof import('node:fs/promises')>()

        return {
          ...real,
          default: real,
          open: () => Promise.reject(Object.assign(new Error('read-only'), { code: 'EROFS' })),
        }
      })

      try {
        const { fileStorage: onAReadOnlyHome } = await import('../src/storage.js')

        await expect(onAReadOnlyHome({ dir }).set('k', 'v')).rejects.toThrow(/read-only/)
        expect(await stat(join(dir, 'auth.json')).catch(() => null)).toBeNull()
      } finally {
        vi.doUnmock('node:fs/promises')
        vi.resetModules()
      }
    })
  })
})
