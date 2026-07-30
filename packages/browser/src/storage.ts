import { fromSyncStorage, memoryStorage, type AuthStorage } from '@ai-oauth-sdk/core'

/**
 * `localStorage`-backed storage.
 *
 * Falls back to in-memory when storage is unavailable — Safari private mode and
 * cross-origin iframes throw on access rather than returning null, and a login
 * flow should degrade to session-scoped rather than crash.
 */
export function localStorageAdapter(): AuthStorage {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__aioauth_probe__'
      localStorage.setItem(probe, '1')
      localStorage.removeItem(probe)
      return fromSyncStorage(localStorage)
    }
  } catch {
    /* fall through to memory */
  }
  return memoryStorage()
}

/**
 * `sessionStorage`-backed storage.
 *
 * The better default for the redirect flow: the PKCE verifier must survive the
 * page navigation, but should not outlive the tab.
 */
export function sessionStorageAdapter(): AuthStorage {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const probe = '__aioauth_probe__'
      sessionStorage.setItem(probe, '1')
      sessionStorage.removeItem(probe)
      return fromSyncStorage(sessionStorage)
    }
  } catch {
    /* fall through to memory */
  }
  return memoryStorage()
}
