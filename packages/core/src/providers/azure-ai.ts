import { defineProvider } from './define.js'
import type { ProviderConfig } from '../types.js'

export interface AzureAiProviderOptions {
  /** Your registered application (client) id. Required. */
  clientId: string
  /**
   * Directory to sign into: a tenant GUID, a domain, or one of the multi-tenant
   * aliases. Defaults to `common`, which accepts work and personal accounts.
   */
  tenant?: string
  /** Defaults to the Azure AI Services scope plus offline access. */
  scopes?: string[]
  /** Loopback port. `0` picks a free one, which Entra accepts. */
  loopbackPort?: number
}

/**
 * Azure AI, reached with an Entra ID sign-in.
 *
 * Entra ID is the login. The token is minted for the Azure AI Services resource
 * (`cognitiveservices.azure.com`), which is what both the Azure OpenAI data
 * plane and Azure AI Foundry accept, since a Foundry resource is an AI Services
 * resource underneath.
 *
 * A factory rather than a constant, because the endpoints are tenant-scoped and
 * there is no public client id to ship: every Azure app registration is its own.
 *
 * ```ts
 * const provider = azureAi({ clientId, tenant: 'contoso.onmicrosoft.com' })
 * const client = createAuthClient({ provider })
 * ```
 *
 * Register the app as a **public client** with a loopback redirect URI; Entra
 * then accepts PKCE without a client secret.
 *
 * The id was `microsoft` before 0.4. `previousIds` carries that, so a stored
 * credential is found under the old key once and moved to the new one.
 */
export function azureAi(options: AzureAiProviderOptions): ProviderConfig {
  const tenant = options.tenant ?? 'common'
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`

  return defineProvider({
    id: 'azure-ai',
    previousIds: ['microsoft'],
    label: 'Azure AI',
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
