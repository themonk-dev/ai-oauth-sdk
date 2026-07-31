import { OAuthError } from '../errors.js'
import { sha256 as sha256Fallback } from './sha256.js'

/**
 * The two primitives this library needs from a runtime. Supply your own to
 * bridge an exotic platform (or to make tests deterministic).
 */
export interface CryptoAdapter {
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array
  /** SHA-256 digest. Async because WebCrypto's `subtle.digest` is async. */
  sha256(data: Uint8Array): Promise<Uint8Array>
}

/**
 * Declared locally rather than using the DOM's `BufferSource`, so core
 * typechecks in projects that do not include the DOM lib (Node, React Native).
 */
type BinaryInput = ArrayBufferView | ArrayBuffer

interface WebCryptoLike {
  getRandomValues?(array: Uint8Array): Uint8Array
  subtle?: { digest(algorithm: string, data: BinaryInput): Promise<ArrayBuffer> }
}

function getWebCrypto(): WebCryptoLike | undefined {
  const candidate = (globalThis as { crypto?: WebCryptoLike }).crypto

  return typeof candidate === 'object' && candidate !== null ? candidate : undefined
}

const NO_SECURE_RANDOM_MESSAGE =
  'No cryptographically secure random source found. `crypto.getRandomValues` is ' +
  'unavailable in this runtime, and OAuth state/PKCE verifiers must not be ' +
  'generated from a weak source. Fixes: on React Native install ' +
  '`react-native-get-random-values` and import it once at the top of your entry ' +
  'file; on Expo use `expo-standard-web-crypto`; otherwise pass a custom ' +
  '`crypto` adapter to `createAuthClient({ crypto })`.'

/**
 * Picks the best primitives the current runtime offers.
 *
 * Randomness is required to be secure — we throw rather than silently fall back
 * to `Math.random`, because a guessable `state` or PKCE verifier defeats the
 * point of both. Hashing, by contrast, has a pure-JS fallback: SHA-256 handles
 * no secrets, so computing it in JS is safe and keeps PKCE working on Hermes
 * where `crypto.subtle` is undefined.
 *
 * Digest input is copied into a standalone buffer because some runtimes reject
 * views with a non-zero `byteOffset`, and `SharedArrayBuffer`-backed views are
 * not valid `BufferSource` everywhere. A `subtle` that exists but refuses to
 * work — some React Native shims, locked-down embedders — falls back to the
 * pure-JS digest rather than breaking login.
 */
export function createDefaultCrypto(): CryptoAdapter {
  const webCrypto = getWebCrypto()

  const randomBytes = (length: number): Uint8Array => {
    const getRandomValues = webCrypto?.getRandomValues

    if (typeof getRandomValues !== 'function') {
      throw new OAuthError('unsupported_runtime', NO_SECURE_RANDOM_MESSAGE)
    }

    return getRandomValues.call(webCrypto, new Uint8Array(length))
  }

  const subtle = webCrypto?.subtle
  const sha256 =
    typeof subtle?.digest === 'function'
      ? async (data: Uint8Array): Promise<Uint8Array> => {
          try {
            const buffer = await subtle.digest('SHA-256', Uint8Array.from(data))

            return new Uint8Array(buffer)
          } catch {
            return sha256Fallback(data)
          }
        }
      : async (data: Uint8Array): Promise<Uint8Array> => sha256Fallback(data)

  return { randomBytes, sha256 }
}

/** True when the runtime can produce secure randomness without extra setup. */
export function hasSecureRandom(): boolean {
  return typeof getWebCrypto()?.getRandomValues === 'function'
}
