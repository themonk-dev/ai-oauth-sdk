import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

/**
 * The provider descriptor the browser examples use.
 *
 * Points at the mock endpoints Vite serves (see `mock-provider.ts`). Note that
 * building this is the *entire* difference between a demo and the real thing —
 * a provider is data, not code.
 *
 * To point an example at a real provider instead:
 *
 * ```ts
 * import { publicClientIds } from '@ai-oauth-sdk/core'
 *
 * // and in the component, replace `demoProvider` with 'openai':
 * useAuth({ provider: 'openai', clientId: publicClientIds.openai, … })
 * ```
 *
 * That will not work from a browser with the *published* ids, though — they are
 * registered for loopback redirects, not web origins. Register your own client
 * with `http://localhost:5173/callback.html` as a redirect URI and pass that id.
 */
export const demoProvider: ProviderConfig = defineProvider({
  id: 'demo',
  label: 'Mock Provider',
  clientId: 'demo-client',
  // Absolute, because the authorization URL is handed to the browser to open —
  // `buildAuthorizationUrl` parses it with `new URL()`, which rejects a path.
  authorizationUrl: `${location.origin}/mock/authorize`,
  tokenUrl: `${location.origin}/mock/token`,
  scopes: ['openid', 'profile', 'email'],
  // The examples supply their own redirect URI, so nothing to declare here.
  redirect: { mode: 'custom' },
  enrichTokens(raw) {
    const account = raw['account']
    if (typeof account !== 'object' || account === null) {
      return {}
    }
    const record = account as Record<string, unknown>
    return {
      ...(typeof record['uuid'] === 'string' ? { accountId: record['uuid'] } : {}),
      ...(typeof record['email_address'] === 'string' ? { email: record['email_address'] } : {}),
    }
  },
})

/** Where the popup lands. Vite serves `public/callback.html` at the root. */
export const demoRedirectUri = `${location.origin}/callback.html`
