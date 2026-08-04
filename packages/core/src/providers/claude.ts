import type { CallbackParseResult, TokenSet } from '../types.js'
import { defineProvider, parseStandardCallback } from './define.js'

/**
 * Claude returns the authorization code to a hosted page as `CODE#STATE`
 * rather than as query params, so the user pastes a single opaque string. We
 * still accept a full redirect URL, because the same provider also supports a
 * loopback redirect where the code arrives normally.
 */
function parseClaudeCallback(input: string): CallbackParseResult {
  const trimmed = input.trim()

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
 * Claude, using the flow Claude Code uses.
 *
 * Defaults to a loopback redirect, so a local server catches the callback and
 * nothing is pasted. Loopback URIs are registered with the port component
 * ignored (RFC 8252), so any port works. `--paste` falls back to the hosted
 * page that displays a code, which is the right answer over SSH.
 *
 * The id was `anthropic` before 0.4. `previousIds` carries that, so a stored
 * credential is found under the old key once and moved to the new one.
 */
export const claude = defineProvider({
  id: 'claude',
  previousIds: ['anthropic'],
  label: 'Claude',
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  /**
   * Enough to chat, and nothing more.
   *
   * `user:inference` is the Messages API, `user:profile` is the identity
   * `whoami` reads, and `user:sessions:claude_code` is the session this grant
   * belongs to. Claude Code also requests `org:create_api_key`,
   * `user:file_upload` and `user:mcp_servers`; those are left out because none
   * is needed to send a prompt, and the first in particular turns a leaked
   * token into durable organization credentials that outlive the OAuth session.
   *
   * Ask for them explicitly when you want them:
   *
   * ```ts
   * createAuthClient({
   *   provider: 'anthropic',
   *   clientId: publicClientIds.anthropic,
   *   scopes: [...anthropic.scopes, 'org:create_api_key', 'user:file_upload'],
   * })
   * ```
   */
  scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
  apiBaseUrl: 'https://api.anthropic.com/v1',
  redirect: {
    mode: 'loopback',
    hostedUri: 'https://platform.claude.com/oauth/code/callback',
    loopbackPort: 0,
    loopbackPath: '/callback',
    /**
     * The consent screen is not the whole flow, and this field is the record
     * of learning that the expensive way.
     *
     * `https://claude.ai/oauth/authorize`, with the published Claude Code
     * client id and an `https://` redirect on an unrelated domain, renders the
     * consent screen in a signed-in browser rather than the
     * `redirect_uri_mismatch` Google answers the equivalent probe with. That
     * looks conclusive and is not: it establishes only that the *authorize*
     * endpoint let the request through. Carrying such a grant to the end fails
     * on the redirect URI anyway, so the browser flow a reader would get from
     * a `true` here is one that reaches consent, takes the user's approval,
     * and then breaks — worse than never offering it.
     *
     * `false` is therefore what this client behaves like from a browser, which
     * is what the field is for. A consumer holding a client id of their own,
     * registered for their own origin, can say so per call rather than
     * inheriting a default written for the published CLI client.
     */
    acceptsHttpsRedirect: false,
  },
  /**
   * Asks for an authorization code rather than a redirect-fragment token.
   * Claude Code sends it alongside a loopback `redirect_uri`, so it does not
   * conflict with catching the callback locally.
   */
  extraAuthParams: { code: 'true' },
  /**
   * The endpoint accepts both form and JSON bodies — verified live, where an
   * invalid grant is answered identically either way. Other clients send JSON;
   * we send the RFC 6749 form encoding. Claude also accepts `state` on the
   * exchange, which most providers reject.
   */
  tokenRequest: { style: 'form', includeClientIdInBody: true, includeState: true },
  parseCallback: parseClaudeCallback,
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
  /**
   * The Messages API requires a version header, and OAuth-bearer requests (as
   * opposed to `x-api-key`) require opting into the OAuth beta.
   */
  apiHeaders() {
    return {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    }
  },
  /**
   * `claude.ai` sends `Cross-Origin-Opener-Policy: same-origin`, enforced
   * rather than report-only. A popup opened to the authorization page is
   * therefore moved into its own browsing-context group: `window.opener` on
   * the popup is null from then on, even after it navigates back to the app's
   * own origin, and the opener's handle to the popup reports `closed === true`
   * while the popup is still open. A popup-based flow needs another way to
   * notice completion.
   */
  authPage: { seversOpener: true },
})
