import type { CallbackParseResult, TokenSet } from '../types.js'
import { defineProvider, parseStandardCallback } from './define.js'

/**
 * Anthropic returns the authorization code to a hosted page as `CODE#STATE`
 * rather than as query params, so the user pastes a single opaque string. We
 * still accept a full redirect URL, because the same provider also supports a
 * loopback redirect where the code arrives normally.
 */
function parseAnthropicCallback(input: string): CallbackParseResult {
  const trimmed = input.trim()

  // A real URL (loopback mode) — let the standard parser handle it.
  if (trimmed.includes('?') || trimmed.startsWith('http')) {
    return parseStandardCallback(trimmed)
  }

  const hashIndex = trimmed.indexOf('#')
  if (hashIndex === -1) {
    return { code: trimmed }
  }
  return { code: trimmed.slice(0, hashIndex), state: trimmed.slice(hashIndex + 1) }
}

/**
 * Anthropic / Claude — the flow Claude Code uses.
 *
 * Defaults to `hosted` redirect + paste, which works on headless boxes and over
 * SSH. Pass a loopback receiver to use `http://localhost:54545/callback`
 * instead; Anthropic registers loopback URIs with the port component ignored
 * (RFC 8252), so any port works.
 */
export const anthropic = defineProvider({
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  scopes: ['user:inference', 'user:profile'],
  apiBaseUrl: 'https://api.anthropic.com/v1',
  redirect: {
    mode: 'hosted',
    hostedUri: 'https://platform.claude.com/oauth/code/callback',
    loopbackPort: 54545,
    loopbackPath: '/callback',
  },
  // The token endpoint rejects JSON bodies; form encoding is required.
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  parseCallback: parseAnthropicCallback,
  enrichTokens(raw, _tokens: TokenSet) {
    const account = raw['account']
    if (typeof account !== 'object' || account === null) {
      return {}
    }
    const record = account as Record<string, unknown>
    const accountId = record['uuid']
    const email = record['email_address']
    return {
      ...(typeof accountId === 'string' ? { accountId } : {}),
      ...(typeof email === 'string' ? { email } : {}),
    }
  },
  apiHeaders() {
    // The Messages API requires a version header, and OAuth-bearer requests
    // (as opposed to `x-api-key`) require opting into the OAuth beta.
    return {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    }
  },
})
