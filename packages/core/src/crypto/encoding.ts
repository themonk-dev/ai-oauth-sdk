const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * base64url per RFC 4648 §5 (no padding).
 *
 * Hand-rolled rather than delegating to `btoa`/`Buffer` because neither is
 * universally present: `Buffer` is Node-only and Hermes (React Native) has
 * shipped without `btoa` in several releases.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0

  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      BASE64URL_ALPHABET[(chunk >> 18) & 63]! +
      BASE64URL_ALPHABET[(chunk >> 12) & 63]! +
      BASE64URL_ALPHABET[(chunk >> 6) & 63]! +
      BASE64URL_ALPHABET[chunk & 63]!
  }

  const remaining = bytes.length - i

  if (remaining === 1) {
    const chunk = bytes[i]! << 16
    out += BASE64URL_ALPHABET[(chunk >> 18) & 63]! + BASE64URL_ALPHABET[(chunk >> 12) & 63]!
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out +=
      BASE64URL_ALPHABET[(chunk >> 18) & 63]! +
      BASE64URL_ALPHABET[(chunk >> 12) & 63]! +
      BASE64URL_ALPHABET[(chunk >> 6) & 63]!
  }

  return out
}

/** Built once, not per call — decoding runs on every JWT we read. */
const BASE64_LOOKUP = new Map<string, number>(
  Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (char, i) => [
    char,
    i,
  ]),
)

/** Decodes base64url *or* standard base64, with or without padding. */
export function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const lookup = BASE64_LOOKUP

  const byteLength = Math.floor((normalized.length * 6) / 8)
  const out = new Uint8Array(byteLength)
  let buffer = 0
  let bits = 0
  let pos = 0

  for (const char of normalized) {
    const value = lookup.get(char)

    if (value === undefined) {
      continue
    }

    buffer = (buffer << 6) | value
    bits += 6

    if (bits >= 8) {
      bits -= 8
      out[pos++] = (buffer >> bits) & 0xff
    }
  }

  return pos === byteLength ? out : out.subarray(0, pos)
}

/**
 * UTF-8 encode. Prefers the platform `TextEncoder` and falls back to a manual
 * encoder for older Hermes builds where it is absent.
 */
export function utf8Encode(input: string): Uint8Array {
  const TE = (globalThis as { TextEncoder?: typeof TextEncoder }).TextEncoder

  if (typeof TE === 'function') {
    return new TE().encode(input)
  }

  const bytes: number[] = []

  for (let i = 0; i < input.length; i++) {
    let codePoint = input.charCodeAt(i)

    /* Combine surrogate pairs into a single code point. */
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1)

      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        i++
      }
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }

  return new Uint8Array(bytes)
}

/** UTF-8 decode, with the same fallback rationale as {@link utf8Encode}. */
export function utf8Decode(bytes: Uint8Array): string {
  const TD = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder

  if (typeof TD === 'function') {
    return new TD().decode(bytes)
  }

  let out = ''
  let i = 0

  while (i < bytes.length) {
    const byte = bytes[i]!
    let codePoint: number

    if (byte < 0x80) {
      codePoint = byte
      i += 1
    } else if (byte < 0xe0) {
      codePoint = ((byte & 0x1f) << 6) | (bytes[i + 1]! & 0x3f)
      i += 2
    } else if (byte < 0xf0) {
      codePoint = ((byte & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f)
      i += 3
    } else {
      codePoint =
        ((byte & 0x07) << 18) |
        ((bytes[i + 1]! & 0x3f) << 12) |
        ((bytes[i + 2]! & 0x3f) << 6) |
        (bytes[i + 3]! & 0x3f)
      i += 4
    }

    out += String.fromCodePoint(codePoint)
  }

  return out
}
