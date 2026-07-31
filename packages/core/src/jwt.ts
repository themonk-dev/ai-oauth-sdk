import { base64UrlDecode, utf8Decode } from './crypto/encoding.js'

/**
 * Reads the payload of a JWT **without verifying its signature**.
 *
 * That is deliberate and safe here: the token arrives over TLS directly from
 * the provider's token endpoint, and we only read it to surface convenience
 * fields (account id, email, expiry). Nothing security-relevant is decided from
 * it — never use this to authenticate a token you received from a third party.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')

  if (parts.length < 2) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(utf8Decode(base64UrlDecode(parts[1]!)))

    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Reads a nested value by dotted path, e.g. `getClaim(p, 'org.id')`. */
export function getClaim(payload: Record<string, unknown> | undefined, path: string): unknown {
  if (!payload) {
    return undefined
  }

  let current: unknown = payload

  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

/** Reads a dotted-path claim, returning it only when it is a string. */
export function getStringClaim(
  payload: Record<string, unknown> | undefined,
  path: string,
): string | undefined {
  const value = getClaim(payload, path)

  return typeof value === 'string' ? value : undefined
}
