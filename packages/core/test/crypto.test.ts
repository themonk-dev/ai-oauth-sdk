import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../src/crypto/encoding.js'
import { sha256 } from '../src/crypto/sha256.js'
import { createDefaultCrypto } from '../src/crypto/adapter.js'
import { deriveChallenge } from '../src/pkce.js'

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

describe('sha256 (pure JS fallback)', () => {
  it('matches the FIPS 180-4 published vectors', () => {
    expect(toHex(sha256(utf8Encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(toHex(sha256(utf8Encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(toHex(sha256(utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('agrees with WebCrypto across lengths that straddle block boundaries', async () => {
    // 55/56/63/64/65 are where SHA-256 padding logic goes wrong if mishandled.
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const input = new Uint8Array(length)

      for (let i = 0; i < length; i++) {
        input[i] = (i * 7 + 13) & 0xff
      }

      const native = new Uint8Array(await webcrypto.subtle.digest('SHA-256', input))
      expect(toHex(sha256(input)), `length ${length}`).toBe(toHex(native))
    }
  })

  it('handles multi-byte UTF-8 identically to WebCrypto', async () => {
    const input = utf8Encode('héllo — 世界 🌍 café')
    const native = new Uint8Array(await webcrypto.subtle.digest('SHA-256', input))
    expect(toHex(sha256(input))).toBe(toHex(native))
  })
})

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length)

      for (let i = 0; i < length; i++) {
        bytes[i] = (i * 31 + 7) & 0xff
      }

      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('emits unpadded, URL-safe output', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 255]))
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })

  it('matches Node base64url for known input', () => {
    const bytes = utf8Encode('the quick brown fox jumps over the lazy dog')
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
  })

  it('accepts padded standard base64 on decode', () => {
    expect(utf8Decode(base64UrlDecode('aGVsbG8='))).toBe('hello')
    expect(utf8Decode(base64UrlDecode('aGVsbG8'))).toBe('hello')
  })

  /*
   * Trailing padding used to be stripped with /=+$/, which backtracks
   * quadratically once a run of '=' is followed by anything else — and a
   * `decodeJwtPayload` call sits directly on the bytes a token endpoint sends,
   * with no length bound anywhere before it. The two tests below pin the two
   * halves: that nothing about the output moved, and that the input shape that
   * used to take seconds now takes milliseconds.
   */
  it('decodes every padding and alphabet shape the same way', () => {
    const cases: { input: string; bytes: number[]; backing: number }[] = [
      { input: '', bytes: [], backing: 0 },
      { input: 'aGVsbG8', bytes: [104, 101, 108, 108, 111], backing: 5 },
      { input: 'aGVsbG8=', bytes: [104, 101, 108, 108, 111], backing: 5 },
      { input: 'aGVsbG8==', bytes: [104, 101, 108, 108, 111], backing: 5 },
      { input: 'aGVsbG8===', bytes: [104, 101, 108, 108, 111], backing: 5 },
      { input: '-_8', bytes: [251, 255], backing: 2 },
      { input: '+/8=', bytes: [251, 255], backing: 2 },
      { input: '++//', bytes: [251, 239, 255], backing: 3 },
      { input: '--__', bytes: [251, 239, 255], backing: 3 },
      { input: 'a=b=c=d', bytes: [105, 183, 29], backing: 5 },
      { input: '!!!', bytes: [], backing: 2 },
      { input: '====', bytes: [], backing: 0 },
      { input: 'aGVsbG8*&^', bytes: [104, 101, 108, 108, 111], backing: 7 },
    ]

    for (const { input, bytes, backing } of cases) {
      const decoded = base64UrlDecode(input)
      expect(Array.from(decoded), input).toEqual(bytes)
      /* Not only the contents. A consumer reading `result.buffer` sees the
         backing store, and simply dropping the strip instead of scanning would
         over-allocate it — `Array.from` would still agree while
         `new Uint8Array(result.buffer)` quietly gained trailing zeroes. */
      expect(decoded.buffer.byteLength, `${input} backing store`).toBe(backing)
    }
  })

  it('decodes a long run of padding without stalling', () => {
    /* JWT-shaped, because that is how it arrives: header.payload.signature
       where a segment is a long run of '=' with one ordinary character after
       it. Against the old regex this took roughly 7.6 seconds and grew
       fourfold with every doubling; a second is a very generous ceiling for
       the linear scan that replaced it. */
    const hostile = `${'='.repeat(100_000)}A`
    const started = Date.now()
    base64UrlDecode(hostile)

    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('utf8 fallback encoder', () => {
  it('matches TextEncoder including surrogate pairs', () => {
    const samples = ['', 'ascii', 'héllo', '世界', '🌍🚀', 'mixed 世界 🌍 text']

    for (const sample of samples) {
      expect(Array.from(utf8Encode(sample))).toEqual(Array.from(new TextEncoder().encode(sample)))
      expect(utf8Decode(utf8Encode(sample))).toBe(sample)
    }
  })
})

describe('PKCE', () => {
  it('produces the RFC 7636 appendix B challenge', async () => {
    // The spec's worked example: verifier -> challenge.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await deriveChallenge(createDefaultCrypto(), verifier, 'S256')
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('gives the same challenge with or without native subtle', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const native = await deriveChallenge(createDefaultCrypto(), verifier, 'S256')

    // Simulate React Native/Hermes: getRandomValues present, subtle absent.
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: original.getRandomValues.bind(original) },
      configurable: true,
    })

    try {
      const fallback = await deriveChallenge(createDefaultCrypto(), verifier, 'S256')
      expect(fallback).toBe(native)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })

  it('passes plain verifiers through unchanged', async () => {
    const verifier = 'abc123'
    expect(await deriveChallenge(createDefaultCrypto(), verifier, 'plain')).toBe(verifier)
  })

  it('generates 43-character verifiers, as the RFC recommends', () => {
    const crypto = createDefaultCrypto()
    const seen = new Set<string>()

    for (let i = 0; i < 50; i++) {
      const verifier = base64UrlEncode(crypto.randomBytes(32))
      expect(verifier).toHaveLength(43)
      expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
      seen.add(verifier)
    }

    expect(seen.size).toBe(50)
  })
})

describe('secure randomness', () => {
  it('refuses to run without a CSPRNG rather than falling back to Math.random', () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })

    try {
      expect(() => createDefaultCrypto().randomBytes(32)).toThrowError(
        /No cryptographically secure random source/,
      )
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})
