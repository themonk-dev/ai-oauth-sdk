import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'

import type { AuthStorage } from '@ai-oauth-sdk/core'

export interface FileStorageOptions {
  /** Directory holding the credential file. Default `~/.ai-oauth-sdk`. */
  dir?: string
  /** File name. Default `auth.json`. */
  file?: string
}

/** Default location, overridable with `AI_OAUTH_SDK_HOME`. */
export function defaultAuthDir(): string {
  return process.env['AI_OAUTH_SDK_HOME'] ?? join(homedir(), '.ai-oauth-sdk')
}

/**
 * In-process serialisation chains, one per credential file.
 *
 * `set` and `delete` are read-modify-writes over the *whole* file, so two of
 * them running at once lose one another's keys. A queue held per `fileStorage()`
 * instance only serialises callers that happen to share an instance, and the
 * ordinary shape of this SDK does not: `createNodeAuthClient` builds a fresh
 * `fileStorage()` for every client, so one client per provider — the documented
 * way to use it — already puts two independent writers on one
 * `~/.ai-oauth-sdk/auth.json`. Two concurrent `refresh()` calls would then roll
 * one provider's rotated token back to the value it had before, which surfaces
 * much later as an `invalid_grant` on a session that looked fine.
 *
 * Keying the chain by the resolved path is what makes the serialisation a
 * property of the *file* rather than of the object that happens to hold it. The
 * map holds one settled promise per distinct path, so it is bounded by the
 * number of credential files a process touches.
 */
const queues = new Map<string, Promise<unknown>>()

/**
 * How long a lock file may sit untouched before a later writer decides its
 * owner died and takes it.
 *
 * The critical section is a read, a JSON round-trip and a rename — under a
 * millisecond in the ordinary case — so ten seconds is not a bound on honest
 * work, it is the point past which "still holding it" stops being plausible. A
 * crashed CLI must not wedge the credential store for the life of the machine,
 * which is what an unconditional wait would do.
 */
const STALE_LOCK_MS = 10_000

/**
 * How long to wait for the lock before failing.
 *
 * Comfortably longer than {@link STALE_LOCK_MS}, so a waiter always reaches the
 * point where it may reclaim an abandoned lock instead of timing out first.
 */
const LOCK_TIMEOUT_MS = 15_000

const LOCK_RETRY_MIN_MS = 5
const LOCK_RETRY_MAX_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Takes the cross-process lock guarding one credential file, and returns the
 * function that releases it.
 *
 * The lock is a sibling file created with `wx` (`O_CREAT|O_EXCL`), which is the
 * one filesystem primitive that is atomic across processes on every platform
 * this adapter runs on: exactly one of two racing writers creates it and the
 * other gets `EEXIST`. Nothing here can be done with an in-process queue — two
 * CLI windows are two processes, and `client.ts` explicitly designs for that
 * being ordinary.
 *
 * A failure to acquire is thrown, never swallowed: the alternative to waiting is
 * writing anyway, and writing anyway is the data loss this exists to prevent.
 */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  // Written into the lock so release can tell "the lock I took" from "a lock
  // someone else took after mine was reclaimed as stale", and only ever remove
  // its own.
  const token = randomBytes(16).toString('hex')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let backoff = LOCK_RETRY_MIN_MS

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)

      try {
        await handle.writeFile(token, 'utf8')
      } finally {
        await handle.close()
      }

      return async () => {
        try {
          if ((await readFile(lockPath, 'utf8')) === token) {
            await unlink(lockPath)
          }
        } catch {
          /* Already gone, or reclaimed by someone else; nothing to release. */
        }
      }
    } catch (error) {
      // Anything other than "someone holds it" — a read-only home directory, a
      // permission problem — is a real failure and belongs to the caller.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }

    await reclaimIfStale(lockPath)

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the lock at ${lockPath} while ` +
          `writing ${path}. Another process is holding it; if none is running, delete that ` +
          'file.',
      )
    }

    await sleep(backoff)
    backoff = Math.min(backoff * 2, LOCK_RETRY_MAX_MS)
  }
}

/** Removes a lock whose owner has plainly gone away. */
async function reclaimIfStale(lockPath: string): Promise<void> {
  try {
    const before = await stat(lockPath)

    if (Date.now() - before.mtimeMs < STALE_LOCK_MS) {
      return
    }

    // Re-stat immediately before removing it and give up if the file changed:
    // between the two calls the dead owner's lock may have been reclaimed by
    // another waiter, and deleting *that* lock would put two writers in the
    // critical section — the very thing being defended. The window is not zero
    // (there is no "unlink if unchanged" syscall), but reaching it needs an
    // owner ten seconds dead and a new one arriving inside the same instant.
    const after = await stat(lockPath)

    if (after.mtimeMs === before.mtimeMs && after.ino === before.ino) {
      await unlink(lockPath)
    }
  } catch {
    /* Gone while we looked at it: the next `wx` open decides who gets it. */
  }
}

/**
 * JSON-file storage for CLIs, written `0600` so other users on the box cannot
 * read the tokens.
 *
 * Writes go to a temp file and are renamed into place: an interrupted write
 * cannot leave a truncated credential file behind. Because a reader therefore
 * always sees one whole record or the previous one, `get` and `keys` need no
 * lock of their own.
 *
 * A `set` or `delete` is a read-modify-write over the whole file, so those are
 * serialised twice over: through a promise chain shared by every
 * {@link fileStorage} in this process that names the same file, and through a
 * lock file that excludes other processes. Neither half is redundant — the chain
 * alone loses writes between two CLI windows, and the lock file alone would have
 * one instance's queued writes contend with another's inside a single process.
 *
 * The directory is created `0700`, but an existing one keeps whatever mode it
 * already has: a `dir` other local users can write to is outside what this
 * adapter can defend.
 */
export function fileStorage(options: FileStorageOptions = {}): AuthStorage {
  const dir = options.dir ?? defaultAuthDir()
  // Resolved, so two spellings of the same path share one queue. Symlinks are
  // not followed, and two names for one file through one are the case the lock
  // file below still covers.
  const path = resolve(dir, options.file ?? 'auth.json')

  const readAll = async (): Promise<Record<string, string>> => {
    try {
      const contents = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(contents)

      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code === 'ENOENT') {
        return {}
      }

      if (error instanceof SyntaxError) {
        return {}
      }

      throw error
    }
  }

  const writeAll = async (record: Record<string, string>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // The temp name is random rather than derived from the pid, and the write
    // is `wx` (`O_CREAT|O_EXCL`), because both halves are load-bearing.
    //
    // `O_EXCL` is the security half: a plain `w` open follows a symlink sitting
    // at the temp path, so anyone who can write to the credential directory
    // could aim the write at a file they own and read every provider's tokens
    // out of it. `mode` does not save us there — it applies only when open(2)
    // creates the inode, so a pre-created 0644 target keeps its permissions,
    // and the trailing `chmod` fails EPERM on a file we do not own.
    //
    // The random name is the correctness half: with `O_EXCL` a predictable name
    // turns one stale temp file — left by a crash, under a pid that has since
    // been recycled — into an `EEXIST` that every later write inherits, which
    // would wedge the credential store permanently.
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`

    try {
      await writeFile(temp, JSON.stringify(record, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `Refusing to overwrite ${temp}: something already exists at the temporary path used to write ${path}.`,
          { cause: error },
        )
      }

      throw error
    }

    try {
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }

    await chmod(path, 0o600).catch(() => {})
  }

  /** Serialises an operation behind whatever is already queued for this file. */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const queue = queues.get(path) ?? Promise.resolve()
    const result = queue.then(operation, operation)
    queues.set(
      path,
      result.catch(() => {}),
    )

    return result
  }

  /**
   * Runs a read-modify-write with no other process inside it.
   *
   * The directory is created first: the lock is a file in it, so there has to be
   * somewhere to put it before anything can be claimed.
   */
  const mutate = (change: (record: Record<string, string>) => boolean): Promise<void> =>
    enqueue(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const release = await acquireLock(path)

      try {
        const record = await readAll()

        if (change(record)) {
          await writeAll(record)
        }
      } finally {
        await release()
      }
    })

  return {
    async get(key) {
      return enqueue(async () => (await readAll())[key] ?? null)
    },
    async set(key, value) {
      return mutate((record) => {
        record[key] = value

        return true
      })
    },
    async delete(key) {
      return mutate((record) => {
        if (!(key in record)) {
          return false
        }

        delete record[key]

        return true
      })
    },
    async keys() {
      return enqueue(async () => Object.keys(await readAll()))
    },
  }
}

export interface StoredSession {
  provider: string
  /** Present when the session was stored under a named account. */
  accountKey?: string
  /** The storage key, for direct access. */
  key: string
}

/**
 * Lists the provider sessions present in a storage backend.
 *
 * Returns an empty list for backends that cannot enumerate (SecureStore), so
 * callers never have to feature-detect.
 */
export async function listStoredSessions(storage: AuthStorage): Promise<StoredSession[]> {
  if (!storage.keys) {
    return []
  }

  const keys = await storage.keys()
  const sessions: StoredSession[] = []

  for (const key of keys) {
    if (!key.startsWith('tokens:')) {
      continue
    }

    const rest = key.slice('tokens:'.length)
    const separator = rest.indexOf(':')
    sessions.push(
      separator === -1
        ? { provider: rest, key }
        : { provider: rest.slice(0, separator), accountKey: rest.slice(separator + 1), key },
    )
  }

  return sessions.sort((a, b) => a.key.localeCompare(b.key))
}
