#!/usr/bin/env node
/**
 * A complete AI-provider login CLI in ~60 lines.
 *
 *   node index.js login openai
 *   node index.js token openai
 *   node index.js logout openai
 */
import { createNodeAuthClient, login, isOAuthError, providers, publicClientIds } from '@ai-oauth-sdk/node'

const [command, providerId = 'openai', ...rest] = process.argv.slice(2)

if (!command || command === 'help') {
  console.log(`
Usage: ai-login <command> [provider]

Commands:
  login   <provider>   Sign in and store the token
  token   <provider>   Print a valid access token (refreshing if needed)
  whoami  <provider>   Show the signed-in account
  logout  <provider>   Forget the stored token

Providers: ${Object.keys(providers).join(', ')}
`)
  process.exit(0)
}

// xAI does not publish a client id, so allow supplying one on the command line.
const clientIdFlag = rest.find((arg) => arg.startsWith('--client-id='))
// Your own id wins; otherwise opt into the one that provider's CLI publishes.
const clientId = clientIdFlag?.split('=')[1] ?? publicClientIds[providerId]

const clientOptions = { provider: providerId, ...(clientId ? { clientId } : {}) }

try {
  switch (command) {
    case 'login': {
      const tokens = await login(providerId, clientId ? { clientId } : {})
      console.log(`\nSigned in to ${providerId}${tokens.email ? ` as ${tokens.email}` : ''}.`)
      if (tokens.expiresAt) {
        console.log(`Token expires ${new Date(tokens.expiresAt).toLocaleString()}.`)
      }
      break
    }

    case 'token': {
      const client = createNodeAuthClient(clientOptions)
      // Refreshes transparently when the stored token is near expiry.
      console.log(await client.getAccessToken())
      break
    }

    case 'whoami': {
      const client = createNodeAuthClient(clientOptions)
      const tokens = await client.getTokens()
      if (!tokens) {
        console.log(`Not signed in to ${providerId}. Run: ai-login login ${providerId}`)
        process.exit(1)
      }
      console.log(`${providerId}: ${tokens.email ?? tokens.accountId ?? 'signed in'}`)
      break
    }

    case 'logout': {
      await createNodeAuthClient(clientOptions).logout()
      console.log(`Signed out of ${providerId}.`)
      break
    }

    default:
      console.error(`Unknown command "${command}". Try: ai-login help`)
      process.exit(1)
  }
} catch (error) {
  // OAuthError carries a machine-readable `code` worth branching on.
  if (isOAuthError(error)) {
    console.error(`\n${error.code}: ${error.message}`)
    if (error.code === 'refresh_failed') {
      console.error(`Run: ai-login login ${providerId}`)
    }
    process.exit(1)
  }
  throw error
}
