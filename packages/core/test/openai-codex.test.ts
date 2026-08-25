import { describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import {
  codexBaseUrl,
  codexClientVersion,
  extractCodexModelSlugs,
  normalizeCodexResponsesBody,
  openai,
} from '../src/providers/openai.js'
import { memoryStorage } from '../src/storage.js'
import type { TokenSet } from '../src/types.js'

const tokens: TokenSet = {
  accessToken: 'access-1',
  tokenType: 'Bearer',
  provider: 'openai',
  accountId: 'acct-1',
  raw: {},
}

async function signedInClient() {
  const client = createAuthClient({
    provider: 'openai',
    clientId: 'test-client',
    storage: memoryStorage(),
  })
  await client.setTokens(tokens)

  return client
}

/** Captures one request without sending it, so nothing here touches OpenAI. */
function recordingFetch() {
  const calls: Array<{ url: string; headers: Headers; body: string | undefined }> = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }

  return { calls, fetchImpl }
}

describe('normalizeCodexResponsesBody', () => {
  it('forces the stateless settings the backend requires', () => {
    const body = normalizeCodexResponsesBody({ model: 'gpt-5.5' })

    expect(body['store']).toBe(false)
    expect(body['reasoning']).toEqual({ effort: 'medium', summary: 'auto' })
    expect(body['include']).toEqual(['reasoning.encrypted_content'])
  })

  it('keeps caller reasoning settings and fills only the gaps', () => {
    const body = normalizeCodexResponsesBody({ reasoning: { effort: 'high' } })

    expect(body['reasoning']).toEqual({ effort: 'high', summary: 'auto' })
  })

  it('does not duplicate an include the caller already asked for', () => {
    const body = normalizeCodexResponsesBody({
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
    })

    expect(body['include']).toEqual(['reasoning.encrypted_content', 'message.output_text.logprobs'])
  })

  it('strips server-side ids and item references from the input', () => {
    const body = normalizeCodexResponsesBody({
      input: [
        { id: 'msg_1', role: 'user', content: 'hi' },
        { type: 'item_reference', id: 'msg_0' },
        { role: 'assistant', content: 'hello' },
      ],
    })

    expect(body['input']).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('drops the token limits the endpoint rejects', () => {
    const body = normalizeCodexResponsesBody({ max_output_tokens: 100, max_completion_tokens: 100 })

    expect('max_output_tokens' in body).toBe(false)
    expect('max_completion_tokens' in body).toBe(false)
  })

  it('leaves the caller object untouched', () => {
    const original: Record<string, unknown> = { model: 'gpt-5.5', max_output_tokens: 10 }
    normalizeCodexResponsesBody(original)

    expect(original['max_output_tokens']).toBe(10)
    expect('store' in original).toBe(false)
  })
})

describe('the openai descriptor', () => {
  it('points at the surface these tokens actually open', () => {
    expect(openai.apiBaseUrl).toBe(codexBaseUrl)
  })

  it('sends the account id and the two headers Codex requires', () => {
    expect(openai.apiHeaders?.(tokens)).toEqual({
      'chatgpt-account-id': 'acct-1',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    })
  })

  it('omits the account id when the token set has none', () => {
    const { accountId: _accountId, ...withoutAccount } = tokens

    expect(openai.apiHeaders?.(withoutAccount)).not.toHaveProperty('chatgpt-account-id')
  })

  it('normalizes a responses body but nothing else', () => {
    const responses = openai.transformRequestBody?.(
      `${codexBaseUrl}/responses`,
      { model: 'gpt-5.5' },
      tokens,
    )
    const models = openai.transformRequestBody?.(`${codexBaseUrl}/models`, { a: 1 }, tokens)

    expect(responses?.['store']).toBe(false)
    expect(models).toEqual({ a: 1 })
  })
})

describe('an authenticated fetch against the Codex surface', () => {
  it('resolves, authenticates, versions and normalizes in one call', async () => {
    const client = await signedInClient()
    const { calls, fetchImpl } = recordingFetch()
    const api = createAuthenticatedFetch(client, { fetch: fetchImpl })

    await api('/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', max_output_tokens: 50 }),
    })

    const call = calls[0]!
    expect(call.url).toBe(`${codexBaseUrl}/responses?client_version=${codexClientVersion}`)
    expect(call.headers.get('authorization')).toBe('Bearer access-1')
    expect(call.headers.get('chatgpt-account-id')).toBe('acct-1')
    expect(call.headers.get('openai-beta')).toBe('responses=experimental')
    expect(call.headers.get('originator')).toBe('codex_cli_rs')

    const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>
    expect(body['store']).toBe(false)
    expect(body['include']).toEqual(['reasoning.encrypted_content'])
    expect('max_output_tokens' in body).toBe(false)
  })

  it('honours a baseUrl override, for an API-key account', async () => {
    const client = await signedInClient()
    const { calls, fetchImpl } = recordingFetch()
    const api = createAuthenticatedFetch(client, {
      fetch: fetchImpl,
      baseUrl: 'https://api.openai.com/v1',
    })

    await api('/models')

    expect(calls[0]?.url).toBe(
      `https://api.openai.com/v1/models?client_version=${codexClientVersion}`,
    )
  })
})

describe('the OpenAI path on a runtime whose URL is only half implemented', () => {
  /**
   * React Native's built-in URL shim in the shape the repo already documents:
   * the constructor and `toString` work, `searchParams` and `pathname` throw.
   * `query.test.ts` deletes the globals outright, which is a stricter
   * environment but a different one — the failure here came from a URL that
   * exists and answers `new URL(...)` happily, so it has to be present.
   *
   * OpenAI is the descriptor that makes this reachable: `apiQuery` returns
   * `client_version` on every request, which is what stopped `applyQuery` early
   * returning, and `transformRequestBody` read `pathname` on every string body
   * before deciding whether it even wanted to rewrite it.
   */
  async function withReactNativeUrl<T>(body: () => Promise<T>): Promise<T> {
    const RealUrl = globalThis.URL

    class ShimUrl {
      private readonly href: string

      constructor(url: string, base?: string) {
        this.href = new RealUrl(url, base).href
      }

      get searchParams(): never {
        throw new Error('URL.searchParams is not implemented')
      }

      get pathname(): never {
        throw new Error('URL.pathname is not implemented')
      }

      toString(): string {
        return this.href
      }
    }

    globalThis.URL = ShimUrl as unknown as typeof URL

    try {
      return await body()
    } finally {
      globalThis.URL = RealUrl
    }
  }

  it('sends a GET, provider query parameter and all', async () => {
    const client = await signedInClient()
    const { calls, fetchImpl } = recordingFetch()
    const api = createAuthenticatedFetch(client, { fetch: fetchImpl })

    await withReactNativeUrl(() => api('/models'))

    expect(calls[0]?.url).toBe(`${codexBaseUrl}/models?client_version=${codexClientVersion}`)
  })

  it('sends a string-bodied POST, and still normalizes it', async () => {
    const client = await signedInClient()
    const { calls, fetchImpl } = recordingFetch()
    const api = createAuthenticatedFetch(client, { fetch: fetchImpl })

    await withReactNativeUrl(() =>
      api('/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.5' }) }),
    )

    const call = calls[0]!
    expect(call.url).toBe(`${codexBaseUrl}/responses?client_version=${codexClientVersion}`)
    expect((JSON.parse(call.body ?? '{}') as Record<string, unknown>)['store']).toBe(false)
  })

  it('leaves a body on another route alone, without reading pathname to find out', async () => {
    const client = await signedInClient()
    const { calls, fetchImpl } = recordingFetch()
    const api = createAuthenticatedFetch(client, { fetch: fetchImpl })

    await withReactNativeUrl(() =>
      api('/models', { method: 'POST', body: JSON.stringify({ a: 1 }) }),
    )

    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ a: 1 })
  })

  it('keeps the caller query parameter winning, the same as elsewhere', async () => {
    const client = await signedInClient()
    const { calls, fetchImpl } = recordingFetch()
    const api = createAuthenticatedFetch(client, { fetch: fetchImpl })

    await withReactNativeUrl(() => api('/models?client_version=9.9.9&other=1'))

    expect(calls[0]?.url).toBe(`${codexBaseUrl}/models?client_version=9.9.9&other=1`)
  })
})

describe('extractCodexModelSlugs', () => {
  it('reads the shapes the endpoint has used', () => {
    expect(extractCodexModelSlugs(['gpt-5.5'])).toEqual(['gpt-5.5'])
    expect(extractCodexModelSlugs({ models: [{ slug: 'gpt-5.5' }] })).toEqual(['gpt-5.5'])
    expect(extractCodexModelSlugs({ data: [{ id: 'gpt-5.4' }] })).toEqual(['gpt-5.4'])
  })

  it('skips entries it cannot read, and deduplicates', () => {
    expect(extractCodexModelSlugs({ models: [{ slug: 'a' }, 42, null, { slug: 'a' }] })).toEqual([
      'a',
    ])
  })

  it('returns nothing for a shape it does not recognise', () => {
    expect(extractCodexModelSlugs({ unexpected: true })).toEqual([])
  })
})
