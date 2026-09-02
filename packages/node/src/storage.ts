import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'

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
 *
 * A promise chain reaches exactly as far as one process; the cross-process case
 * is documented on {@link fileStorage} and deliberately left open.
 */
const queues = new Map<string, Promise<unknown>>()

/**
 * JSON-file storage for CLIs, written `0600` so other users on the box cannot
 * read the tokens.
 *
 * Writes go to a temp file and are renamed into place: an interrupted write
 * cannot leave a truncated credential file behind, and a reader always sees one
 * whole record or the previous one.
 *
 * A `set` or `delete` is a read-modify-write over the whole file, so those are
 * serialised through a promise chain shared by every {@link fileStorage} in this
 * process that names the same file — including the ordinary shape where
 * `createNodeAuthClient` builds one client, and so one adapter, per provider.
 *
 * ## Limitation: two processes can still lose a write
 *
 * Serialisation stops at the process boundary. Two CLI windows writing to one
 * `~/.ai-oauth-sdk/auth.json` interleave read/read/write/write, and the second
 * write — built on a record read before the first landed — drops the other's
 * key with no error on either side. This is not a hairline race: two logins that
 * start within a few milliseconds of each other lose one of the two records
 * essentially every time, because both read the file before either renames.
 * Sequential use is unaffected, and so is any number of writers inside one
 * process.
 *
 * This is left open on purpose. Closing it needs mutual exclusion between
 * processes, and the only primitive Node exposes without a native dependency is
 * an `O_EXCL` sentinel file, which has no safe expiry: a lock is either held
 * forever by a process that was `SIGKILL`ed — wedging every later login on the
 * machine — or reclaimed on a timeout, in which case a writer merely *slow*
 * (a suspended laptop, an NFS home, a stopped process, a debugger) has its lock
 * taken while it is still inside the read-modify-write, and its rename then
 * silently overwrites the record the reclaimer wrote. A heartbeat does not save
 * it: `SIGSTOP` freezes the heartbeat and the writer alike, and the writer wakes
 * up and finishes. There is no atomic "unlink only if still mine" either, so a
 * release can delete a *live* lock and admit a third writer. A lock like that is
 * worse than the race it replaces: it destroys writes that had already completed
 * under a lock the writer believed it held, while making the store look
 * defended. An advisory `flock`/`fcntl` lock — the primitive that actually has
 * these properties — needs a native module, and this package is dependency-free
 * by design.
 *
 * Callers who need cross-process safety should give each process its own file
 * (`dir`/`file`), or pass their own {@link AuthStorage} backed by something with
 * real transactions — an OS keychain, a database.
 *
 * The directory is created `0700`, but an existing one keeps whatever mode it
 * already has: a `dir` other local users can write to is outside what this
 * adapter can defend.
 */
export function fileStorage(options: FileStorageOptions = {}): AuthStorage {
  const dir = options.dir ?? defaultAuthDir()
  // `join`, not `resolve`: an absolute `file` must not escape `dir`.
  const path = join(dir, options.file ?? 'auth.json')
  // The queue is keyed by the absolute path so that two spellings of one file —
  // `{dir: './creds'}` and `{dir: '/home/me/creds'}` — share a chain rather than
  // racing. `resolve` normalises against the process's own cwd, so this is a
  // canonical name for the same process's purposes; it does not follow symlinks,
  // and two names for one file through one are not serialised.
  const queueKey = resolve(path)

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
    const queue = queues.get(queueKey) ?? Promise.resolve()
    const result = queue.then(operation, operation)
    queues.set(
      queueKey,
      result.catch(() => {}),
    )

    return result
  }

  /**
   * Runs a read-modify-write with no other writer in this process inside it.
   *
   * Nothing is created until `change` says there is something to write, so a
   * `delete` of a key that is not there stays a pure no-op — it neither creates
   * the credential directory nor fails on a read-only home.
   */
  const mutate = (change: (record: Record<string, string>) => boolean): Promise<void> =>
    enqueue(async () => {
      const record = await readAll()

      if (change(record)) {
        await writeAll(record)
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
