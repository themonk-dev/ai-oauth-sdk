import type { AuthStorage } from '@ai-oauth-sdk/core'

import type { AsyncStorageLike, SecureStoreLike } from './deps.js'

/**
 * `@react-native-async-storage/async-storage` adapter.
 *
 * Note this is *not* encrypted at rest. Prefer {@link secureStoreAdapter} for
 * refresh tokens; use this only when the extra dependency is unacceptable.
 */
export function asyncStorageAdapter(storage: AsyncStorageLike): AuthStorage {
  return {
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    delete: (key) => storage.removeItem(key),
  }
}

export interface SecureStoreOptions {
  /** Forwarded to every `expo-secure-store` call (e.g. `keychainAccessible`). */
  options?: Record<string, unknown>
}

/**
 * Encodes a key into SecureStore's allowed alphabet, reversibly.
 *
 * SecureStore accepts only alphanumerics, `.`, `-` and `_`. Mapping every other
 * character onto a single `_` would be lossy, and lossy is dangerous here:
 * `accountKey: 'me@corp.com'` and `accountKey: 'me/corp.com'` would collide on
 * one entry and overwrite each other's tokens. Escaping as `_` plus the code
 * unit keeps the mapping injective — `_` is itself escaped, so nothing else can
 * produce an escape sequence.
 */
function encodeSecureStoreKey(key: string): string {
  return key.replace(
    /[^A-Za-z0-9.-]/g,
    (character) => `_${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * `expo-secure-store` adapter — Keychain on iOS, EncryptedSharedPreferences on
 * Android. The right home for OAuth refresh tokens on a mobile device.
 */
export function secureStoreAdapter(
  store: SecureStoreLike,
  options: SecureStoreOptions = {},
): AuthStorage {
  const safeKey = encodeSecureStoreKey

  return {
    get: (key) => store.getItemAsync(safeKey(key), options.options),
    set: (key, value) => store.setItemAsync(safeKey(key), value, options.options),
    delete: (key) => store.deleteItemAsync(safeKey(key), options.options),
  }
}
