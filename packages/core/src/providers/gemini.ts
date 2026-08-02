import { decodeJwtPayload, getStringClaim } from '../jwt.js'
import type { TokenSet } from '../types.js'
import { defineProvider } from './define.js'

/**
 * Gemini, using the flow the Gemini CLI uses.
 *
 * Gemini's "installed application" clients need both a `clientId` and a
 * `clientSecret`. That secret is not confidential in the usual sense, since the
 * published docs say installed-app secrets cannot be treated as such, but the
 * token endpoint rejects the exchange without one, so both are published:
 *
 * ```ts
 * createAuthClient({
 *   provider: 'google',
 *   clientId: publicClientIds.google,
 *   clientSecret: publicClientSecrets.google,
 * })
 * ```
 *
 * Register a "Desktop app" OAuth client in the Google Cloud console to present
 * as yourself instead. PKCE is what actually secures the flow; the secret is a
 * formality the token endpoint insists on.
 *
 * `loopbackPort: 0` means "bind any free port". Loopback redirects are accepted
 * on arbitrary ports (RFC 8252), which avoids collisions.
 *
 * No device flow is declared, deliberately. The device endpoint exists but
 * accepts only a client registered as "TVs and Limited Input devices", and a
 * coding CLI is not a television — the published gemini-cli client is a Desktop
 * app and is refused with `Invalid client type`. Declaring the endpoint would
 * advertise a flow that cannot work here.
 */
export const gemini = defineProvider({
  id: 'gemini',
  previousIds: ['google'],
  label: 'Gemini',
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
  /** `access_type: offline` is required for a refresh token to be returned at all. */
  extraAuthParams: {
    access_type: 'offline',
    prompt: 'consent',
  },
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  note:
    'Gemini needs a clientId *and* a clientSecret. publicClientIds.google and ' +
    'publicClientSecrets.google are the pair gemini-cli ships; installed-app ' +
    'secrets are non-confidential by design. Register your own "Desktop app" ' +
    'client in the Google Cloud console to present as yourself instead.',
  enrichTokens(raw, tokens: TokenSet) {
    const payload = decodeJwtPayload(tokens.idToken ?? String(raw['id_token'] ?? ''))
    const accountId = getStringClaim(payload, 'sub')
    const email = getStringClaim(payload, 'email')

    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) }
  },
})
