import { describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import { copilotClientHeaders, githubCopilot } from '../src/providers/github-copilot.js'
import { memoryStorage } from '../src/storage.js'
import type { TokenSet } from '../src/types.js'

const EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token'

const tokens: TokenSet = {
  accessToken: 'ghu_github-token',
  tokenType: 'Bearer',
  provider: 'github-copilot',
  raw: {},
}

async function signedInClient() {
  const client = createAuthClient({
    provider: 'github-copilot',
    clientId: 'test-client',
    storage: memoryStorage(),
  })
  await client.setTokens(tokens)

  return client
}

interface StubOptions {
  /** Seconds from now the exchanged token expires. */
  expiresIn?: number
  /** Host GitHub names for this account, or none. */
  apiHost?: string | null
}

/**
 * Stands in for both GitHub endpoints: the token exchange, and the Copilot API
 * itself. Nothing here reaches the network.
 */
function stubGitHub({ expiresIn = 1500, apiHost = 'https://api.individual.githubcopilot.com' }: StubOptions = {}) {
  const exchanges: Array<Record<string, string>> = []
  const calls: Array<{ url: string; headers: Headers }> = []
  let issued = 0
  let apiStatus = 200

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === EXCHANGE_URL) {
      const seen: Record<string, string> = {}
      new Headers(init?.headers).forEach((value, key) => {
        seen[key] = value
      })
      exchanges.push(seen)
      issued += 1

      return Response.json({
        token: `copilot-token-${issued}`,
        expires_at: Math.floor((Date.now() + expiresIn * 1000) / 1000),
        ...(apiHost ? { endpoints: { api: apiHost } } : {}),
      })
    }

    calls.push({ url, headers: new Headers(init?.headers) })

    return new Response('{}', { status: apiStatus, headers: { 'content-type': 'application/json' } })
  }

  return {
    exchanges,
    calls,
    fetchImpl,
    get exchangeCount() {
      return issued
    },
    failApiOnce(status: number) {
      apiStatus = status
    },
    recoverApi() {
      apiStatus = 200
    },
  }
}

describe('the github-copilot descriptor', () => {
  it('declares an exchange, because the stored token is not the API credential', () => {
    expect(githubCopilot.exchangeCredential).toBeTypeOf('function')
  })
})

describe('an authenticated fetch against Copilot', () => {
  it('sends the exchanged token, not the GitHub one', async () => {
    const client = await signedInClient()
    const github = stubGitHub()
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/chat/completions', { method: 'POST', body: '{}' })

    expect(github.exchanges[0]?.['authorization']).toBe('token ghu_github-token')
    expect(github.calls[0]?.headers.get('authorization')).toBe('Bearer copilot-token-1')
  })

  it('sends it to the host GitHub named, not the descriptor default', async () => {
    const client = await signedInClient()
    const github = stubGitHub({ apiHost: 'https://api.enterprise.githubcopilot.com' })
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/chat/completions')

    expect(github.calls[0]?.url).toBe('https://api.enterprise.githubcopilot.com/chat/completions')
  })

  it('falls back to the descriptor host when GitHub names none', async () => {
    const client = await signedInClient()
    const github = stubGitHub({ apiHost: null })
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/chat/completions')

    expect(github.calls[0]?.url).toBe(`${githubCopilot.apiBaseUrl}/chat/completions`)
  })

  it('lets an explicit baseUrl option win over both', async () => {
    const client = await signedInClient()
    const github = stubGitHub()
    const api = createAuthenticatedFetch(client, {
      fetch: github.fetchImpl,
      baseUrl: 'https://copilot.internal.example',
    })

    await api('/chat/completions')

    expect(github.calls[0]?.url).toBe('https://copilot.internal.example/chat/completions')
  })

  it('names the editor, which Copilot requires', async () => {
    const client = await signedInClient()
    const github = stubGitHub()
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/chat/completions')

    expect(github.calls[0]?.headers.get('copilot-integration-id')).toBe(
      copilotClientHeaders['Copilot-Integration-Id'],
    )
    expect(github.calls[0]?.headers.get('editor-version')).toBe(
      copilotClientHeaders['Editor-Version'],
    )
  })

  it('lets the caller identify as something else', async () => {
    const client = await signedInClient()
    const github = stubGitHub()
    const api = createAuthenticatedFetch(client, {
      fetch: github.fetchImpl,
      headers: { 'Editor-Version': 'my-cli/1.0' },
    })

    await api('/chat/completions')

    expect(github.calls[0]?.headers.get('editor-version')).toBe('my-cli/1.0')
  })

  it('exchanges once and reuses it, since the exchange is a round trip', async () => {
    const client = await signedInClient()
    const github = stubGitHub()
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/one')
    await api('/two')
    await api('/three')

    expect(github.exchangeCount).toBe(1)
    expect(github.calls).toHaveLength(3)
  })

  it('re-exchanges when the Copilot token is inside its renewal window', async () => {
    const client = await signedInClient()
    // Shorter than the 60s skew, so it is already due for renewal on arrival.
    const github = stubGitHub({ expiresIn: 30 })
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/one')
    await api('/two')

    expect(github.exchangeCount).toBe(2)
  })

  it('re-exchanges on a 401, since a token can be revoked early', async () => {
    const client = await signedInClient()
    const github = stubGitHub()
    const api = createAuthenticatedFetch(client, { fetch: github.fetchImpl })

    await api('/warm-the-cache')
    expect(github.exchangeCount).toBe(1)

    github.failApiOnce(401)
    await api('/now-unauthorized')

    expect(github.exchangeCount).toBe(2)
    expect(github.calls.at(-1)?.headers.get('authorization')).toBe('Bearer copilot-token-2')
  })
})
