import { afterEach, describe, expect, it } from 'vitest'

import { buildAuthorizationUrl } from '../src/authorize.js'
import { createAuthClient } from '../src/client.js'
import {
  githubCopilot,
  microsoft,
  openrouter,
  providers,
  publicClientIds,
  qwen,
} from '../src/providers/index.js'
import { memoryStorage } from '../src/storage.js'
import { startFakeAuthServer, type FakeAuthServer } from './helpers/fakeAuthServer.js'

const servers: FakeAuthServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('OpenRouter — a provider that breaks the spec', () => {
  it('renames redirect_uri and drops the params it does not accept', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: openrouter,
        clientId: 'openrouter',
        redirectUri: 'http://localhost:7777/callback',
        state: 'some-state',
        codeChallenge: 'challenge-abc',
      }),
    )

    expect(url.searchParams.get('callback_url')).toBe('http://localhost:7777/callback')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    // None of these are part of OpenRouter's flow.
    expect(url.searchParams.get('redirect_uri')).toBeNull()
    expect(url.searchParams.get('client_id')).toBeNull()
    expect(url.searchParams.get('response_type')).toBeNull()
    expect(url.searchParams.get('state')).toBeNull()
    expect(url.searchParams.get('scope')).toBeNull()
  })

  it('completes end to end despite the callback carrying no state', async () => {
    const target = await startFakeAuthServer()
    servers.push(target)

    const client = createAuthClient({
      provider: {
        ...openrouter,
        authorizationUrl: `${target.url}/openrouter/auth`,
        tokenUrl: `${target.url}/openrouter/keys`,
      },
      redirectUri: 'http://localhost:7777/callback',
      storage: memoryStorage(),
    })

    const authorization = await client.createAuthorization()
    const response = await fetch(authorization.url, { redirect: 'manual' })
    const callbackUrl = response.headers.get('location')!
    expect(new URL(callbackUrl).searchParams.get('state')).toBeNull()

    // No state to correlate on, so it resolves against the latest pending flow.
    const tokens = await client.completeAuthorization({ callbackUrl })

    // The server verified PKCE, so the verifier survived the rename.
    expect(tokens.accessToken).toBe('sk-or-v1-userkey')
    expect(tokens.tokenType).toBe('Bearer')
    // A durable user API key: nothing to refresh, nothing to expire.
    expect(tokens.expiresAt).toBeUndefined()
    expect(tokens.refreshToken).toBeUndefined()
  })

  it('sends the exchange as JSON, which is what OpenRouter requires', async () => {
    const target = await startFakeAuthServer()
    servers.push(target)

    const client = createAuthClient({
      provider: {
        ...openrouter,
        authorizationUrl: `${target.url}/openrouter/auth`,
        tokenUrl: `${target.url}/openrouter/keys`,
      },
      redirectUri: 'http://localhost:7777/callback',
      storage: memoryStorage(),
    })

    const authorization = await client.createAuthorization()
    const response = await fetch(authorization.url, { redirect: 'manual' })
    await client.completeAuthorization({ callbackUrl: response.headers.get('location')! })

    // Parsed as JSON by the fake endpoint; a form body would not have.
    expect(target.requests[0]).toMatchObject({ code: 'or-code-1' })
    expect(target.requests[0]?.['code_verifier']).toBe(authorization.codeVerifier)
  })

  it('still rejects a stateless callback for providers that do echo state', async () => {
    const target = await startFakeAuthServer()
    servers.push(target)

    const client = createAuthClient({
      provider: {
        ...openrouter,
        echoesState: true, // pretend it behaves
        authorizationUrl: `${target.url}/openrouter/auth`,
        tokenUrl: `${target.url}/openrouter/keys`,
      },
      redirectUri: 'http://localhost:7777/callback',
      storage: memoryStorage(),
    })
    await client.createAuthorization()

    await expect(
      client.completeAuthorization({ callbackUrl: 'http://localhost:7777/callback?code=abc' }),
    ).rejects.toMatchObject({ code: 'state_mismatch' })
  })
})

describe('GitHub Copilot', () => {
  it('is device-flow only and says so', () => {
    expect(githubCopilot.deviceAuthorizationUrl).toBe('https://github.com/login/device/code')
    expect(githubCopilot.redirect.mode).toBe('custom')
    expect(githubCopilot.note).toMatch(/device flow only/)
  })

  it('disables PKCE, which GitHub does not use for the device grant', () => {
    expect(githubCopilot.usePkce).toBe(false)
  })

  it('creates a client without a redirect URI', () => {
    expect(() =>
      createAuthClient({
        provider: 'github-copilot',
        clientId: publicClientIds['github-copilot'],
        storage: memoryStorage(),
      }),
    ).not.toThrow()
  })
})

describe('Qwen', () => {
  it('is device-flow only and flagged experimental', () => {
    expect(qwen.deviceAuthorizationUrl).toContain('/device/code')
    expect(qwen.experimental).toBe(true)
    expect(qwen.note).toMatch(/device flow only/)
  })
})

describe('Microsoft factory', () => {
  it('scopes the endpoints to the tenant', () => {
    const provider = microsoft({ clientId: 'app-1', tenant: 'contoso.onmicrosoft.com' })
    expect(provider.authorizationUrl).toContain('contoso.onmicrosoft.com')
    expect(provider.tokenUrl).toContain('contoso.onmicrosoft.com')
    expect(provider.clientId).toBe('app-1')
  })

  it('defaults to the common (any account) tenant', () => {
    expect(microsoft({ clientId: 'app-1' }).authorizationUrl).toContain('/common/')
  })

  it('URL-encodes a tenant that needs it', () => {
    const provider = microsoft({ clientId: 'a', tenant: 'my tenant' })
    expect(provider.authorizationUrl).toContain('my%20tenant')
  })

  it('asks for offline_access so a refresh token comes back', () => {
    expect(microsoft({ clientId: 'a' }).scopes).toContain('offline_access')
  })
})

describe('registry after expansion', () => {
  it('exposes all seven built-ins', () => {
    expect(Object.keys(providers).sort()).toEqual([
      'anthropic',
      'github-copilot',
      'google',
      'openai',
      'openrouter',
      'qwen',
      'xai',
    ])
  })

  it('still embeds no vendor client secrets', () => {
    for (const provider of Object.values(providers)) {
      expect(provider.clientSecret, `${provider.id}`).toBeUndefined()
    }
  })

  it('gives every provider a token endpoint and a label', () => {
    for (const provider of Object.values(providers)) {
      expect(provider.tokenUrl, provider.id).toMatch(/^https:\/\//)
      expect(provider.label, provider.id).toBeTruthy()
    }
  })
})
