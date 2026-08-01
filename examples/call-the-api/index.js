/**
 * The whole loop: sign in, then call the provider's API with the token.
 *
 *   node index.js openai
 *   node index.js anthropic
 *   node index.js google
 *
 * Signing in is the easy part. What usually goes wrong afterwards is the
 * *other* headers a provider expects, and the moment a token expires mid-run.
 * `createAuthenticatedFetch` handles both.
 */
import {
  createAuthenticatedFetch,
  extractCodexModelSlugs,
  isOAuthError,
  publicClientIds,
  publicClientSecrets,
} from '@ai-oauth-sdk/core'
import { createNodeAuthClient, login } from '@ai-oauth-sdk/node'

const providerId = process.argv[2] ?? 'openai'

/** What to ask each provider for, since their APIs differ. */
const countModels = (body) => `${body.data?.length ?? 0} models available`

const whoami = (body) => `signed in as ${body.email ?? body.sub ?? 'unknown'}`

const listCodexModels = (body) => `${extractCodexModelSlugs(body).length} models available`

const REQUESTS = {
  anthropic: { path: '/models', describe: countModels },
  openrouter: { path: '/models', describe: countModels },
  xai: { path: '/models', describe: countModels },
  qwen: { path: '/models', describe: countModels },

  // A ChatGPT sign-in is not an API key: OpenAI's authorization server offers
  // only openid/profile/email/offline_access, so `api.openai.com/v1/models`
  // answers 403 "Missing scopes: api.model.read". It does open the Codex
  // surface, which is where `apiBaseUrl` points, so the relative path below
  // resolves to chatgpt.com and the descriptor supplies the rest.
  openai: { path: '/models', describe: listCodexModels },

  // Google's coding endpoint is not a model list, and reaching it needs a
  // project handshake first. Identity is what the token plainly grants. An
  // absolute URL bypasses `apiBaseUrl`, which `createAuthenticatedFetch`
  // honours.
  google: { path: 'https://openidconnect.googleapis.com/v1/userinfo', describe: whoami },
}

const request = REQUESTS[providerId]

if (!request) {
  console.error(`No sample request configured for "${providerId}".`)
  console.error(`Try one of: ${Object.keys(REQUESTS).join(', ')}`)
  process.exit(1)
}

// You name the credential. publicClientIds holds the ones the vendors' own CLIs
// publish — pass your own instead if you registered one. Google is the only
// provider whose token endpoint also insists on a secret.
const clientId = publicClientIds[providerId]
const clientSecret = publicClientSecrets[providerId]
const credentials = {
  ...(clientId ? { clientId } : {}),
  ...(clientSecret ? { clientSecret } : {}),
}

const client = createNodeAuthClient({ provider: providerId, ...credentials })

// Sign in only when there is nothing stored at all. Note the test: an *expired*
// token is not a reason to open a browser, because `createAuthenticatedFetch`
// renews it transparently below. Gating on `isAuthenticated()` instead would
// force a full login every time a token aged out, which is the whole thing the
// refresh token exists to avoid.
if (!(await client.getTokens())) {
  console.log(`Not signed in to ${providerId}. Starting login…`)
  const tokens = await login(providerId, credentials)
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
