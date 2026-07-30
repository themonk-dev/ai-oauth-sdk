import { defineProvider } from './define.js'
import type { ProviderConfig } from '../types.js'

export interface MicrosoftProviderOptions {
  /** Your registered application (client) id. Required. */
  clientId: string
  /**
   * Directory to sign into: a tenant GUID, a domain, or one of the multi-tenant
   * aliases. Defaults to `common` (any Microsoft account).
   */
  tenant?: string
  /** Defaults to Azure OpenAI's user_impersonation scope plus offline access. */
  scopes?: string[]
  /** Loopback port. `0` picks a free one, which Entra accepts. */
  loopbackPort?: number
}

/**
 * Microsoft Entra ID (formerly Azure AD) — for Azure OpenAI.
 *
 * A factory rather than a constant, because the endpoints are tenant-scoped and
 * there is no public client id to ship: every Azure app registration is its own.
 *
 * ```ts
 * const provider = microsoft({ clientId, tenant: 'contoso.onmicrosoft.com' })
 * const client = createAuthClient({ provider })
 * ```
 *
 * Register the app as a **public client** with a loopback redirect URI; Entra
 * then accepts PKCE without a client secret.
 */
export function microsoft(options: MicrosoftProviderOptions): ProviderConfig {
  const tenant = options.tenant ?? 'common'
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`

  return defineProvider({
    id: 'microsoft',
    label: 'Microsoft (Entra ID)',
    clientId: options.clientId,
    authorizationUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    deviceAuthorizationUrl: `${base}/devicecode`,
    revocationUrl: `${base}/logout`,
    userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: options.scopes ?? [
      'https://cognitiveservices.azure.com/.default',
      'offline_access',
      'openid',
      'profile',
    ],
    redirect: {
      mode: 'loopback',
      loopbackPort: options.loopbackPort ?? 0,
      loopbackPath: '/callback',
    },
    tokenRequest: { style: 'form', includeClientIdInBody: true },
  })
}
