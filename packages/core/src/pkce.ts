import type { CryptoAdapter } from './crypto/adapter.js'
import { base64UrlEncode, utf8Encode } from './crypto/encoding.js'

export type PkceMethod = 'S256' | 'plain'

export interface PkcePair {
  verifier: string
  challenge: string
  method: PkceMethod
}

/**
 * RFC 7636 allows a verifier of 43–128 characters. 32 random bytes encode to
 * exactly 43 base64url characters, which is the spec's recommended entropy.
 */
const DEFAULT_VERIFIER_BYTES = 32

export function createVerifier(crypto: CryptoAdapter, bytes = DEFAULT_VERIFIER_BYTES): string {
  return base64UrlEncode(crypto.randomBytes(bytes))
}

/** Derives the challenge for a verifier. `plain` is passthrough, per RFC 7636 §4.2. */
export async function deriveChallenge(
  crypto: CryptoAdapter,
  verifier: string,
  method: PkceMethod = 'S256',
): Promise<string> {
  if (method === 'plain') {
    return verifier
  }
  return base64UrlEncode(await crypto.sha256(utf8Encode(verifier)))
}

export async function createPkce(
  crypto: CryptoAdapter,
  method: PkceMethod = 'S256',
): Promise<PkcePair> {
  const verifier = createVerifier(crypto)
  return { verifier, challenge: await deriveChallenge(crypto, verifier, method), method }
}

/** URL-safe random string, used for `state` and `nonce`. */
export function createRandomString(crypto: CryptoAdapter, bytes = 32): string {
  return base64UrlEncode(crypto.randomBytes(bytes))
}
