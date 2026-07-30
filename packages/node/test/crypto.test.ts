import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { base64UrlEncode, deriveChallenge, publicClientIds, utf8Encode } from '@ai-oauth-sdk/core'

import { nodeCrypto } from '../src/crypto.js'
import { createNodeAuthClient } from '../src/index.js'

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

let removedGlobal = false

/**
 * Simulates the environments where Node has WebCrypto but does not expose it
 * globally: early 18.x releases, and any VM context (several test runners and
 * sandboxes run code that way).
 */
function hideGlobalCrypto() {
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  removedGlobal = true
}

afterEach(() => {
  if (removedGlobal) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
    removedGlobal = false
  }
})

describe('nodeCrypto', () => {
  it('produces secure random bytes of the requested length', () => {
    const bytes = nodeCrypto().randomBytes(32)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(32)
  })

  it('does not repeat itself', () => {
    const crypto = nodeCrypto()
    const seen = new Set(Array.from({ length: 50 }, () => toHex(crypto.randomBytes(32))))
    expect(seen.size).toBe(50)
  })

  it('matches the FIPS 180-4 SHA-256 vectors', async () => {
    const crypto = nodeCrypto()
    expect(toHex(await crypto.sha256(utf8Encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(toHex(await crypto.sha256(utf8Encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('derives the RFC 7636 appendix B challenge', async () => {
    const challenge = await deriveChallenge(
      nodeCrypto(),
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'S256',
    )
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('works when globalThis.crypto is absent', async () => {
    hideGlobalCrypto()

    // The whole point: core would throw `unsupported_runtime` here, but Node
    // has perfectly good WebCrypto under a different name.
    const crypto = nodeCrypto()
    expect(crypto.randomBytes(16)).toHaveLength(16)
    expect(toHex(await crypto.sha256(utf8Encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('createNodeAuthClient', () => {
  it('uses node:crypto by default, so login works without the global', async () => {
    hideGlobalCrypto()

    const client = createNodeAuthClient({
      provider: 'openai',
      clientId: publicClientIds.openai,
      persist: false,
      redirectUri: 'http://localhost:1455/auth/callback',
    })
    const authorization = await client.createAuthorization()
    const url = new URL(authorization.url)

    expect(authorization.state).toHaveLength(43)
    expect(url.searchParams.get('code_challenge')).toHaveLength(43)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('still honours an explicitly supplied crypto adapter', async () => {
    const client = createNodeAuthClient({
      provider: 'openai',
      clientId: publicClientIds.openai,
      persist: false,
      redirectUri: 'http://localhost:1455/auth/callback',
      crypto: {
        // Deterministic, so the derived values are predictable.
        randomBytes: (length) => new Uint8Array(length).fill(7),
        sha256: nodeCrypto().sha256,
      },
    })
    const authorization = await client.createAuthorization()

    expect(authorization.state).toBe(base64UrlEncode(new Uint8Array(32).fill(7)))
  })
})
