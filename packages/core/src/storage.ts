import type { AuthStorage } from './types.js'

/** In-process storage. The default, and all a short-lived CLI run needs. */
export function memoryStorage(initial?: Map<string, string>): AuthStorage {
  const map = initial ?? new Map<string, string>()
  return {
    async get(key) {
      return map.get(key) ?? null
    },
    async set(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    },
    async keys() {
      return [...map.keys()]
    },
  }
}

/**
 * Namespaces every key, so several clients can share one backing store.
 *
 * Forwards `keys()` when the backing store has one, listing only this prefix's
 * keys and handing them back unprefixed. Dropping the method here would quietly
 * disable the registry's `prune()`, and abandoned logins would accumulate in
 * the backing store forever.
 */
export function prefixedStorage(storage: AuthStorage, prefix: string): AuthStorage {
  const key = (k: string) => `${prefix}${k}`
  const adapter: AuthStorage = {
    get: (k) => storage.get(key(k)),
    set: (k, v) => storage.set(key(k), v),
    delete: (k) => storage.delete(key(k)),
  }

  const backingKeys = storage.keys
  if (backingKeys) {
    adapter.keys = async () =>
      (await backingKeys.call(storage))
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
  }
  return adapter
}

/**
 * A synchronous key/value store (`localStorage`, `sessionStorage`, or anything
 * with the same three methods).
 *
 * `length`/`key` are optional because the minimal three-method shape is a
 * perfectly good store — but both Web Storage objects have them, and supplying
 * them is what lets expired records be swept.
 */
export interface SyncStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length?: number
  key?(index: number): string | null
}

/** Adapts a {@link SyncStorageLike} to {@link AuthStorage}. */
export function fromSyncStorage(storage: SyncStorageLike): AuthStorage {
  const adapter: AuthStorage = {
    async get(key) {
      return storage.getItem(key)
    },
    async set(key, value) {
      storage.setItem(key, value)
    },
    async delete(key) {
      storage.removeItem(key)
    },
  }

  // Web Storage can enumerate; a bare three-method store cannot. Expose `keys`
  // only when it will actually work, since callers feature-detect it.
  if (typeof storage.key === 'function' && typeof storage.length === 'number') {
    adapter.keys = async () => {
      const found: string[] = []
      // Read `length` fresh — it is a live getter on Web Storage.
      for (let index = 0; index < (storage.length ?? 0); index++) {
        const key = storage.key?.(index)
        if (key !== null && key !== undefined) {
          found.push(key)
        }
      }
      return found
    }
  }
  return adapter
}
