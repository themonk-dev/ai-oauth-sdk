import { describe, expect, it } from 'vitest'

import { buildLoopbackRedirectUri } from '../src/authorize.js'
import { defineProvider } from '../src/providers/index.js'
import type { ProviderConfig } from '../src/types.js'

const loopbackProvider = (loopbackHost?: string, loopbackPath?: string): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    scopes: ['openid'],
    redirect: {
      mode: 'loopback',
      loopbackPort: 0,
      ...(loopbackHost ? { loopbackHost } : {}),
      ...(loopbackPath ? { loopbackPath } : {}),
    },
  })

describe('buildLoopbackRedirectUri', () => {
  it('defaults to localhost and /callback', () => {
    expect(buildLoopbackRedirectUri(loopbackProvider(), 1455)).toBe(
      'http://localhost:1455/callback',
    )
  })

  it("honours the provider's host and path", () => {
    expect(buildLoopbackRedirectUri(loopbackProvider('127.0.0.1', 'auth/callback'), 56121)).toBe(
      'http://127.0.0.1:56121/auth/callback',
    )
  })

  it('brackets an IPv6 literal', () => {
    // Without brackets the address's own colons run into the port separator:
    // `http://::1:34835/callback` is not a URI (RFC 3986 §3.2.2), so the
    // authorization server is handed a malformed redirect and `new URL()` on
    // it throws.
    const uri = buildLoopbackRedirectUri(loopbackProvider('::1'), 34835)

    expect(uri).toBe('http://[::1]:34835/callback')
    // The point of the brackets: `new URL()` accepts it and reads the port
    // back. Unbracketed it throws, so the assertion above is not enough.
    expect(new URL(uri).port).toBe('34835')
  })

  it('does not double-bracket a host that is already bracketed', () => {
    expect(buildLoopbackRedirectUri(loopbackProvider('[::1]'), 34835)).toBe(
      'http://[::1]:34835/callback',
    )
  })
})
