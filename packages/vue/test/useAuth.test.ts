import { memoryStorage, providers, type TokenSet } from '@ai-oauth-sdk/core'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, isProxy, isReadonly, toRaw } from 'vue'

import { useAuth } from '../src/index.js'

const token: TokenSet = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  tokenType: 'Bearer',
  provider: providers.claude.id,
  raw: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' },
}

/**
 * Drives the composable to the point where a token is in the ref, which needs
 * an effect scope for `onScopeDispose` and a settled `restore()`.
 */
async function mountWithToken() {
  const storage = memoryStorage(new Map([[`tokens:${providers.claude.id}`, JSON.stringify(token)]]))
  const scope = effectScope()

  const auth = scope.run(() =>
    useAuth({ provider: providers.claude, clientId: 'test-client', storage }),
  )!

  // `restoreOnMount` kicks off an async read; wait for it to land in the ref.
  await vi.waitFor(() => expect(auth.tokens.value).toBeDefined())

  return { auth, scope }
}

/**
 * `readonly()` is the deep variant: applied to a ref it proxies whatever
 * `.value` returns, so the caller never receives the `TokenSet` the store
 * holds. `shallowRef` was chosen precisely because a `TokenSet` is replaced
 * wholesale rather than reached into, and the exposure has to agree with that.
 */
describe('useAuth tokens exposure', () => {
  it('hands back the store’s own object, not a proxy of it', async () => {
    const { auth, scope } = await mountWithToken()

    try {
      expect(isProxy(auth.tokens.value)).toBe(false)
      expect(auth.tokens.value).toBe(toRaw(auth.tokens.value))
      expect(auth.tokens.value?.raw).toBeDefined()
      expect(isProxy(auth.tokens.value?.raw)).toBe(false)
    } finally {
      scope.stop()
    }
  })

  it('survives structuredClone, so it can cross a worker boundary', async () => {
    const { auth, scope } = await mountWithToken()

    try {
      // A Proxy is not cloneable: this throws `DataCloneError` if the token is
      // wrapped, which is what a `postMessage` to a worker would hit.
      const cloned = structuredClone(auth.tokens.value)

      expect(cloned).toEqual(auth.tokens.value)
    } finally {
      scope.stop()
    }
  })

  it('still protects the ref itself from reassignment', async () => {
    const { auth, scope } = await mountWithToken()

    try {
      expect(isReadonly(auth.tokens)).toBe(true)
    } finally {
      scope.stop()
    }
  })
})
