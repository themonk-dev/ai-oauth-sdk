import { decodeJwtPayload, getStringClaim } from '../jwt.js'
import type { TokenSet } from '../types.js'
import { defineProvider } from './define.js'

/**
 * Google / Gemini — the flow the Gemini CLI uses.
 *
 * Ships without credentials. Google's "installed application" clients need both
 * a `clientId` and a `clientSecret`, and while that secret is not confidential
 * in the usual sense — Google's own docs say installed-app secrets cannot be
 * treated as such, and their token endpoint rejects the exchange without one —
 * it is still a credential belonging to whoever registered the client. Rather
 * than embedding another vendor's, supply your own:
 *
 * ```ts
 * createAuthClient({
 *   provider: 'google',
 *   clientId: '<id>.apps.googleusercontent.com',
 *   clientSecret: '<secret>',
 * })
 * ```
 *
 * Register a "Desktop app" OAuth client in the Google Cloud console to get a
 * pair. PKCE is what actually secures the flow; the secret is a formality
 * Google's endpoint insists on.
 *
 * `loopbackPort: 0` means "bind any free port" — Google accepts loopback
 * redirects on arbitrary ports (RFC 8252), which avoids collisions.
 */
export const google = defineProvider({
  id: 'google',
  label: 'Gemini (Google)',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  apiBaseUrl: 'https://cloudcode-pa.googleapis.com',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  redirect: { mode: 'loopback', loopbackPort: 0, loopbackPath: '/oauth2callback' },
  extraAuthParams: {
    // Required for Google to return a refresh token at all.
    access_type: 'offline',
    prompt: 'consent',
  },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  note:
    'Google requires your own OAuth client. Register a "Desktop app" client in ' +
    'the Google Cloud console, then pass `clientId` and `clientSecret` to ' +
    'createAuthClient({ provider: "google", clientId, clientSecret }).',
  enrichTokens(raw, tokens: TokenSet) {
    const payload = decodeJwtPayload(tokens.idToken ?? String(raw['id_token'] ?? ''))
    const accountId = getStringClaim(payload, 'sub')
    const email = getStringClaim(payload, 'email')
    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) }
  },
})
