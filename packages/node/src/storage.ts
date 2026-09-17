import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'

import type { AuthStorage } from '@ai-oauth-sdk/core'

export interface FileStorageOptions {
  /** Directory holding the credential file. Default `~/.ai-oauth-sdk`. */
  dir?: string
  /** File name. Default `auth.json`. */
  file?: string
}

/**
 * Default location, overridable with `AI_OAUTH_SDK_HOME`.
 *
 * Empty counts as unset, not as a directory. `AI_OAUTH_SDK_HOME=""` is what a
 * compose file, a workflow `env:` block or `export AI_OAUTH_SDK_HOME="$UNSET"`
 * produces when the value behind it is missing, and `join('', 'auth.json')` is
 * the relative path `auth.json` — so the refresh token would land in whatever
 * directory the process happened to start in, which in CI is the checked-out
 * repository. `--auth-dir` has always treated an empty value as absent; this is
 * the same test, so the env var really is "same as --auth-dir" as it is
 * documented to be.
 *
 * A relative value that is not empty is still honoured: `AI_OAUTH_SDK_HOME=.creds`
 * means `.creds`, because someone who wrote that chose it.
 */
export function defaultAuthDir(): string {
  return process.env['AI_OAUTH_SDK_HOME'] || join(homedir(), '.ai-oauth-sdk')
}

/**
 * JSON-file storage for CLIs, written `0600` so other users on the box cannot
 * read the tokens.
 *
 * Writes go to a temp file and are renamed into place: an interrupted write
 * cannot leave a truncated credential file behind. All reads and writes are
 * serialised through a promise chain so concurrent `set` calls do not clobber
 * each other's copy of the record.
 *
 * The directory is created `0700`, but an existing one keeps whatever mode it
 * already has: a `dir` other local users can write to is outside what this
 * adapter can defend.
 */
export function fileStorage(options: FileStorageOptions = {}): AuthStorage {
  /* `||`, not `??`: an empty `dir` is a value that went missing somewhere up the
     call chain, and it would put the credential file in the process CWD. Every
     other channel — `--auth-dir`, `AI_OAUTH_SDK_HOME` — already reads empty as
     absent, so this one does too rather than being the odd one out. */
  const dir = options.dir || defaultAuthDir()
  const path = join(dir, options.file ?? 'auth.json')
  let queue: Promise<unknown> = Promise.resolve()

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

  /** Serialises an operation behind whatever is already queued. */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => {})

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
