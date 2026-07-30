import { decodeJwtPayload, getStringClaim } from '../jwt.js'
import type { TokenSet } from '../types.js'
import { defineProvider } from './define.js'

/**
 * xAI / Grok — **experimental**.
 *
 * Unlike the other three, xAI does not publish its desktop client id, so this
 * descriptor deliberately ships without one and `createAuthClient` will throw a
 * `configuration_error` until you supply your own:
 *
 * ```ts
 * createAuthClient({ provider: 'xai', clientId: '<your client id>' })
 * ```
 *
 * Endpoints are taken from xAI's OIDC discovery document at
 * `https://auth.x.ai/.well-known/openid-configuration`. If they move, override
 * `authorizationUrl`/`tokenUrl`, or build a fresh descriptor with
 * `providerFromDiscovery()`.
 */
export const xai = defineProvider({
  id: 'xai',
  label: 'Grok (xAI)',
  authorizationUrl: 'https://auth.x.ai/oauth2/authorize',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  deviceAuthorizationUrl: 'https://auth.x.ai/oauth2/device/code',
  revocationUrl: 'https://auth.x.ai/oauth2/revoke',
  userInfoUrl: 'https://auth.x.ai/oauth2/userinfo',
  apiBaseUrl: 'https://api.x.ai/v1',
  scopes: ['openid', 'profile', 'email', 'offline_access', 'api:access'],
  redirect: { mode: 'loopback', loopbackPort: 56121, loopbackPath: '/callback', loopbackHost: '127.0.0.1' },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  experimental: true,
  note:
    'xAI does not publish a public client id. Supply your own via ' +
    '`createAuthClient({ provider: "xai", clientId })`.',
  enrichTokens(raw, tokens: TokenSet) {
    const payload = decodeJwtPayload(tokens.idToken ?? String(raw['id_token'] ?? ''))
    const accountId = getStringClaim(payload, 'sub')
    const email = getStringClaim(payload, 'email')
    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) }
  },
})
