import { describe, expect, it } from 'vitest'

import { createAuthClient } from '../src/client.js'
import { createAuthenticatedFetch } from '../src/fetch.js'
import { OAuthError } from '../src/errors.js'
import {
  chatgptPlanType,
  codexAuthJson,
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

/** An unsigned JWT with OpenAI's namespaced claim, enough for the decoders here. */
function chatgptJwt(auth: Record<string, unknown>, top: Record<string, unknown> = {}): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${encode({ alg: 'none' })}.${encode({ ...top, 'https://api.openai.com/auth': auth })}.sig`
}

/** A well-formed JWT from somebody else entirely — no OpenAI claim anywhere. */
function foreignJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`
}

describe('chatgptPlanType', () => {
  it('reads the plan from the id_token', () => {
    expect(
      chatgptPlanType({
        accessToken: chatgptJwt({ chatgpt_plan_type: 'free' }),
        idToken: chatgptJwt({ chatgpt_plan_type: 'plus' }),
      }),
    ).toBe('plus')
  })

  it('falls back to the access token, and to nothing', () => {
    expect(chatgptPlanType({ accessToken: chatgptJwt({ chatgpt_plan_type: 'pro' }) })).toBe('pro')
    expect(chatgptPlanType({ accessToken: 'opaque' })).toBeUndefined()
    expect(chatgptPlanType({ accessToken: chatgptJwt({}) })).toBeUndefined()
  })
})

describe('codexAuthJson', () => {
  const idToken = chatgptJwt({ chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' }, { email: 'a@b.c' })
  const now = new Date('2026-09-13T00:00:00Z')

  it('renders the file codex reads, with every field codex requires present', () => {
    expect(
      codexAuthJson(
        { accessToken: 'access-1', refreshToken: 'refresh-1', idToken, accountId: 'acct-1' },
        { now },
      ),
    ).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      last_refresh: '2026-09-13T00:00:00.000Z',
      tokens: { access_token: 'access-1', account_id: 'acct-1', id_token: idToken, refresh_token: 'refresh-1' },
    })
  })

  it('never writes null where codex wants a string', () => {
    // A `null` in either field makes the whole file unparsable, and codex then
    // runs unauthenticated against api.openai.com rather than failing loudly.
    const accessToken = chatgptJwt({ chatgpt_plan_type: 'plus' })
    const file = codexAuthJson({ accessToken }, { now })

    expect(file.tokens.refresh_token).toBe('')
    expect(file.tokens.id_token).toBe(accessToken)
    expect(file.tokens).not.toHaveProperty('account_id')
    expect(JSON.stringify(file.tokens)).not.toContain('null')
  })

  it('refuses a token set codex could not parse', () => {
    expect(() => codexAuthJson({ accessToken: 'opaque' })).toThrow(OAuthError)
    expect(() => codexAuthJson({ accessToken: '' , idToken })).toThrow(OAuthError)
  })

  it('refuses a JWT that decodes but carries no ChatGPT claim', () => {
    // Decoding is not the bar: codex reads the account out of the namespaced
    // claim, so a well-formed token from another issuer parses, yields no
    // account, and leaves codex running unauthenticated against
    // api.openai.com. That has to be an error here rather than a silent one
    // hours later.
    const google = foreignJwt({ iss: 'https://accounts.google.com', sub: '1', email: 'a@b.c' })

    expect(() => codexAuthJson({ accessToken: google, idToken: google })).toThrow(OAuthError)
  })

  it('falls back to the access token when the id_token carries no claim', () => {
    // `idToken` is whatever the token endpoint returned, and it is not always
    // the token codex wants. Preferring it before checking it refused a token
    // set that has exactly what codex needs, just not in the first field.
    const accessToken = chatgptJwt({ chatgpt_plan_type: 'plus' })
    const file = codexAuthJson({ accessToken, idToken: 'opaque-id-token' }, { now })

    expect(file.tokens.id_token).toBe(accessToken)
  })

  it('accepts an empty claim object, which a real account can carry', () => {
    // Personal and organization tokens carry different sub-keys, so the claim's
    // contents are not something to hold a token to — its presence is.
    expect(codexAuthJson({ accessToken: chatgptJwt({}) }, { now }).tokens.id_token).toBe(
      chatgptJwt({}),
    )
  })
})
