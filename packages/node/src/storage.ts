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
 * One serialisation chain per credential file, shared by every `fileStorage()`
 * built over that file in this process.
 *
 * `set` is a read-modify-rewrite of the *whole* record, so two of them running
 * concurrently against one file both read the same base and the second rename
 * discards the first's key — silently, because both writes succeed. A chain
 * stored on the storage object itself does not prevent that: a client is free
 * to build its own adapter, and `createNodeAuthClient` builds a fresh one per
 * client, so a process holding an OpenAI client and a Claude client has two
 * instances pointed at the same `auth.json`. Two overlapping token refreshes on
 * a single client reach the same shape through `setTokens`. Keying the chain on
 * the file rather than the instance is what makes those cases safe.
 *
 * The key is the *resolved* path, so a relative `dir` and the absolute one it
 * denotes share a chain. Two names that reach one file by other means — a
 * symlinked directory, a bind mount, a case-insensitive filesystem — still get
 * separate chains and can still clobber each other.
 *
 * This is a per-process guard only. Two `ai-oauth` processes writing the same
 * file concurrently are not serialised by anything here; that would need an
 * advisory lock on disk, with the stale-lock handling that implies, and is
 * deliberately out of scope. The map holds one settled promise per file path,
 * which is bounded by the number of credential files a process touches.
 */
const queues = new Map<string, Promise<unknown>>()

/**
 * JSON-file storage for CLIs, written `0600` so other users on the box cannot
 * read the tokens.
 *
 * Writes go to a temp file and are renamed into place: an interrupted write
 * cannot leave a truncated credential file behind. All reads and writes are
 * serialised through a promise chain keyed on the file, so concurrent `set`
 * calls within this process do not clobber each other's copy of the record —
 * including calls made through two different `fileStorage()` instances. Writes
 * from a *separate* process are not serialised; see {@link queues}.
 *
 * The directory is created `0700`, but an existing one keeps whatever mode it
 * already has: a `dir` other local users can write to is outside what this
 * adapter can defend.
 */
export function fileStorage(options: FileStorageOptions = {}): AuthStorage {
  const dir = options.dir ?? defaultAuthDir()
  const path = resolve(join(dir, options.file ?? 'auth.json'))

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
        // An unparseable file must not wedge login, so the record still reads
        // as empty — but it must not be *discarded* either. `set` rewrites the
        // whole file from whatever `readAll` returned, so returning `{}` alone
        // turns the next sign-in to any one provider into a silent wipe of
        // every other provider's refresh token. A zero-length `auth.json` is
        // the same shape and is a realistic post-crash artifact.
        //
        // Moving the bad file aside keeps both properties: login proceeds, and
        // the old credentials are still on disk for a human to salvage. The
        // suffix puts it outside every path this adapter reads — `auth.json`
        // and `auth.json.<hex>.tmp` — so it cannot be mistaken for the record
        // later. `rename` preserves the inode, and with it the `0600` mode.
        // Failure to rename is swallowed: a read-only directory should still
        // not wedge a caller that only wanted to read.
        await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {})

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

      // Any other failure — `ENOSPC` part-way through, `EIO`, a quota refusal —
      // leaves a partially written temp file holding every provider's tokens in
      // plaintext, and nothing else ever sweeps it: the name is random, so the
      // next write picks a fresh one, and even `logout` does not remove it.
      //
      // The unlink has to sit *below* the `EEXIST` branch. On `EEXIST` we never
      // created that inode — it is whatever was already there, which is exactly
      // the planted symlink `O_EXCL` exists to refuse — and removing it would
      // hand the attacker the retry they were denied.
      await unlink(temp).catch(() => {})

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
    const result = (queues.get(path) ?? Promise.resolve()).then(operation, operation)
    // The stored tail is the swallowed copy: one failed `set` must not reject
    // every operation queued behind it.
    queues.set(path, result.catch(() => {}))

    return result
  }

  return {
    async get(key) {
      return enqueue(async () => (await readAll())[key] ?? null)
    },
    async set(key, value) {
      return enqueue(async () => {
        const record = await readAll()
        record[key] = value
        await writeAll(record)
      })
    },
    async delete(key) {
      return enqueue(async () => {
        const record = await readAll()

        if (!(key in record)) {
          return
        }

        delete record[key]
        await writeAll(record)
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
