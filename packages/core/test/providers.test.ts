import { describe, expect, it } from 'vitest'

import { buildAuthorizationUrl, defaultRedirectUri } from '../src/authorize.js'
import { OAuthError } from '../src/errors.js'
import { createAuthClient } from '../src/client.js'
import { memoryStorage } from '../src/storage.js'
import {
  azureAi,
  claude,
  defineProvider,
  gemini,
  openai,
  parseStandardCallback,
  providers,
  readCallback,
  resolveProvider,
  xai,
} from '../src/providers/index.js'

describe('built-in provider descriptors', () => {
  it('exposes every built-in provider', () => {
    expect(Object.keys(providers)).toContain('openai')
    expect(Object.keys(providers)).toContain('claude')
    expect(Object.keys(providers)).toContain('gemini')
    expect(Object.keys(providers)).toContain('xai')
  })

  it('uses S256 wherever PKCE applies', () => {
    for (const provider of Object.values(providers)) {
      // GitHub's device grant legitimately has no PKCE; everything that does
      // use it must use S256, never `plain`.
      if (!provider.usePkce) {
        continue
      }

      expect(provider.pkceMethod, provider.id).toBe('S256')
    }
  })

  it('enables PKCE for every redirect-based provider', () => {
    for (const provider of Object.values(providers)) {
      /* Device-flow only. */
      if (provider.redirect.mode === 'custom') {
        continue
      }


      expect(provider.usePkce, provider.id).toBe(true)
    }
  })

  it('carries the OpenAI Codex endpoints', () => {
    expect(openai.authorizationUrl).toBe('https://auth.openai.com/oauth/authorize')
    expect(defaultRedirectUri(openai)).toBe('http://localhost:1455/auth/callback')
  })

  // Claude Code catches the callback on a local server rather than making the
  /*
   * The hosted page stays declared so `--paste` still has somewhere to send
   * people over SSH.
   */
  it('defaults Anthropic to loopback, keeping the hosted page for pasting', () => {
    expect(claude.redirect.mode).toBe('loopback')
    expect(claude.redirect.loopbackPort).toBe(0)
    expect(claude.redirect.hostedUri).toBe('https://platform.claude.com/oauth/code/callback')
    // Port 0 means "pick one at bind time", so there is no static default URI.
    expect(defaultRedirectUri(claude)).toBeUndefined()
  })

  /*
   * Claude Code asks for more than this. `org:create_api_key` in particular
   * lets a leaked token mint durable org credentials that outlive the session,
   * so it stays opt-in rather than riding along with every chat token.
   */
  it('asks Anthropic for no more than chat needs', () => {
    expect(claude.scopes).toContain('user:inference')
    expect(claude.scopes).not.toContain('org:create_api_key')
    expect(claude.scopes).not.toContain('user:file_upload')
    expect(claude.scopes).not.toContain('user:mcp_servers')
  })

  it('gives Google an ephemeral loopback port', () => {
    expect(gemini.redirect.loopbackPort).toBe(0)
    // Port 0 means "pick one at bind time", so there is no static default URI.
    expect(defaultRedirectUri(gemini)).toBeUndefined()
  })

  it('marks xAI experimental and withholds a client id', () => {
    expect(xai.experimental).toBe(true)
    expect(xai.clientId).toBeUndefined()
  })

  it('ships no embedded credentials at all', () => {
    // The Passport model: the consumer names the credential at init. Nothing is
    // silently defaulted, so no provider can present as a vendor's CLI by
    // accident.
    for (const provider of Object.values(providers)) {
      expect(provider.clientId, `${provider.id} must not embed a client id`).toBeUndefined()
      expect(provider.clientSecret, `${provider.id} must not embed a secret`).toBeUndefined()
    }
  })
})

describe('buildAuthorizationUrl', () => {
  it('includes the standard OAuth params plus PKCE', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: openai,
        clientId: 'client-123',
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 'state-abc',
        codeChallenge: 'challenge-xyz',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('state')).toBe('state-abc')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access')
  })

  it("carries the provider's own extra params", () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: openai,
        clientId: 'c',
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 's',
      }),
    )
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
  })

  it('asks Google for offline access, so a refresh token comes back', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: gemini,
        clientId: 'c',
        redirectUri: 'http://localhost:0/oauth2callback',
        state: 's',
      }),
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('lets call-site params win over provider defaults', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: openai,
        clientId: 'c',
        redirectUri: 'http://localhost:1455/auth/callback',
        state: 's',
        scopes: ['custom:scope'],
        extraParams: { codex_cli_simplified_flow: 'false', prompt: 'login' },
      }),
    )
    expect(url.searchParams.get('scope')).toBe('custom:scope')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('false')
    expect(url.searchParams.get('prompt')).toBe('login')
  })
})

describe('readCallback — the shared receiver path', () => {
  // Every receiver (loopback, popup, deep link, auth session) funnels through
  // this, so a change here reaches all four platforms at once.
  it('returns code and state from a successful callback', () => {
    expect(readCallback(openai, '?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('omits state rather than setting it undefined', () => {
    expect(readCallback(openai, '?code=abc')).toEqual({ code: 'abc' })
  })

  it('throws authorization_denied with the provider detail attached', () => {
    let caught: unknown

    try {
      readCallback(openai, '?error=access_denied&error_description=User%20said%20no&state=xyz')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OAuthError)
    const error = caught as OAuthError
    expect(error.code).toBe('authorization_denied')
    expect(error.message).toContain('User said no')
    expect(error.providerError).toBe('access_denied')
    expect(error.providerErrorDescription).toBe('User said no')
    expect(error.state).toBe('xyz')
  })

  it('treats a callback with neither code nor error as a denial', () => {
    expect(() => readCallback(openai, '?foo=bar')).toThrow(/no code returned/)
  })

  it("honours a provider's own parser", () => {
    // Claude pastes back `code#state`, which the standard parser cannot read.
    expect(readCallback(claude, 'authcode123#statexyz')).toEqual({
      code: 'authcode123',
      state: 'statexyz',
    })
  })
})

describe('callback parsing', () => {
  it('reads a full redirect URL', () => {
    expect(parseStandardCallback('http://localhost:1455/auth/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    })
  })

  it('reads a bare query string', () => {
    expect(parseStandardCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
    expect(parseStandardCallback('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('surfaces provider errors', () => {
    const parsed = parseStandardCallback('?error=access_denied&error_description=User%20said%20no')
    expect(parsed.error).toBe('access_denied')
    expect(parsed.errorDescription).toBe('User said no')
    expect(parsed.code).toBeUndefined()
  })

  it("parses Anthropic's code#state paste format", () => {
    expect(claude.parseCallback!('authcode123#statexyz')).toEqual({
      code: 'authcode123',
      state: 'statexyz',
    })
  })

  it('still accepts a real URL for Anthropic loopback mode', () => {
    expect(claude.parseCallback!('http://localhost:54545/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    })
  })

  it('tolerates a pasted code with no state', () => {
    expect(claude.parseCallback!('justacode')).toEqual({ code: 'justacode' })
  })
})

describe('resolveProvider', () => {
  it('resolves built-ins by id', () => {
    expect(resolveProvider('openai').id).toBe('openai')
  })

  it('applies overrides without mutating the built-in', () => {
    const custom = resolveProvider('openai', { clientId: 'mine', scopes: ['a', 'b'] })
    expect(custom.clientId).toBe('mine')
    expect(custom.scopes).toEqual(['a', 'b'])
    // The shared descriptor must be untouched for the next caller.
    expect(openai.clientId).toBeUndefined()
    expect(openai.scopes).toEqual(['openid', 'profile', 'email', 'offline_access'])
  })

  it('throws a helpful error for an unknown id', () => {
    expect(() => resolveProvider('nope')).toThrowError(OAuthError)
    expect(() => resolveProvider('nope')).toThrowError(/Built-ins: openai, claude, gemini, xai/)
  })

  it('accepts an inline descriptor', () => {
    const custom = defineProvider({
      id: 'acme',
      label: 'Acme',
      clientId: 'acme-client',
      authorizationUrl: 'https://acme.test/authorize',
      tokenUrl: 'https://acme.test/token',
      scopes: ['read'],
      redirect: { mode: 'loopback', loopbackPort: 9999 },
    })
    expect(resolveProvider(custom).id).toBe('acme')
    // defineProvider supplies the conventional defaults.
    expect(custom.usePkce).toBe(true)
    expect(custom.pkceMethod).toBe('S256')
    expect(custom.tokenRequest.style).toBe('form')
    expect(custom.redirect.loopbackPath).toBe('/callback')
  })
})

describe('renamed provider ids', () => {
  it('declares the id each renamed provider used to have', () => {
    expect(claude.previousIds).toEqual(['anthropic'])
    expect(gemini.previousIds).toEqual(['google'])
    expect(azureAi({ clientId: 'x' }).previousIds).toEqual(['microsoft'])
  })

  it('finds a credential stored under the old id, and moves it', async () => {
    const storage = memoryStorage()
    const tokens = { accessToken: 'a', tokenType: 'Bearer', provider: 'anthropic', raw: {} }
    await storage.set('tokens:anthropic', JSON.stringify(tokens))

    const client = createAuthClient({ provider: 'claude', clientId: 'c', storage })

    expect(await client.getTokens()).toEqual(tokens)
    // Moved rather than copied, so the next read takes the direct path.
    expect(await storage.get('tokens:claude')).toBe(JSON.stringify(tokens))
    expect(await storage.get('tokens:anthropic')).toBeNull()
  })

  it('keeps the account suffix when it moves one', async () => {
    const storage = memoryStorage()
    const tokens = { accessToken: 'a', tokenType: 'Bearer', provider: 'anthropic', raw: {} }
    await storage.set('tokens:anthropic:work', JSON.stringify(tokens))

    const client = createAuthClient({
      provider: 'claude',
      clientId: 'c',
      accountKey: 'work',
      storage,
    })

    expect(await client.getTokens()).toEqual(tokens)
    expect(await storage.get('tokens:claude:work')).toBe(JSON.stringify(tokens))
  })

  it('prefers a credential already under the new id', async () => {
    const storage = memoryStorage()
    await storage.set('tokens:anthropic', JSON.stringify({ accessToken: 'old' }))
    await storage.set('tokens:claude', JSON.stringify({ accessToken: 'new' }))

    const client = createAuthClient({ provider: 'claude', clientId: 'c', storage })

    expect((await client.getTokens())?.accessToken).toBe('new')
  })
})
