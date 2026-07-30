/**
 * The whole loop: sign in, then call the provider's API with the token.
 *
 *   node index.js openai
 *   node index.js anthropic
 *
 * Signing in is the easy part. What usually goes wrong afterwards is the
 * *other* headers a provider expects, and the moment a token expires mid-run.
 * `createAuthenticatedFetch` handles both.
 */
import { createAuthenticatedFetch, isOAuthError, publicClientIds } from '@ai-oauth-sdk/core'
import { createNodeAuthClient, login } from '@ai-oauth-sdk/node'

const providerId = process.argv[2] ?? 'openai'

/** What to ask each provider for, since their APIs differ. */
const REQUESTS = {
  openai: {
    path: '/models',
    describe: (body) => `${body.data?.length ?? 0} models available`,
  },
  anthropic: {
    path: '/models',
    describe: (body) => `${body.data?.length ?? 0} models available`,
  },
  openrouter: {
    path: '/models',
    describe: (body) => `${body.data?.length ?? 0} models available`,
  },
}

const request = REQUESTS[providerId]
if (!request) {
  console.error(`No sample request configured for "${providerId}".`)
  console.error(`Try one of: ${Object.keys(REQUESTS).join(', ')}`)
  process.exit(1)
}

// You name the client id. publicClientIds holds the ones the vendors' own CLIs
// publish — pass your own instead if you registered one.
const clientId = publicClientIds[providerId]
const client = createNodeAuthClient({ provider: providerId, ...(clientId ? { clientId } : {}) })

// Sign in only if we have to — the token from a previous run is reused, and
// refreshed transparently when it is close to expiring.
if (!(await client.isAuthenticated())) {
  console.log(`Not signed in to ${providerId}. Starting login…`)
  const tokens = await login(providerId, clientId ? { clientId } : {})
  console.log(`Signed in${tokens.email ? ` as ${tokens.email}` : ''}.\n`)
}

// This fetch attaches the bearer token, adds whatever extra headers the
// provider requires (OpenAI wants the account id, Anthropic a version plus a
// beta flag), and recovers from a 401 by refreshing once and retrying.
const api = createAuthenticatedFetch(client)

try {
  const response = await api(request.path)

  if (!response.ok) {
    console.error(`API returned HTTP ${response.status}`)
    console.error((await response.text()).slice(0, 500))
    process.exit(1)
  }

  const body = await response.json()
  console.log(`${providerId}: ${request.describe(body)}`)
} catch (error) {
  if (isOAuthError(error) && error.code === 'refresh_failed') {
    console.error('Session expired and could not be refreshed. Sign in again:')
    console.error(`  node index.js ${providerId}`)
    process.exit(1)
  }
  throw error
}
