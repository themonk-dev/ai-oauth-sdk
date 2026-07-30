/**
 * The state-keyed handoff, in a plain Node HTTP server.
 *
 * The login *starts* on one request (`GET /login`) and *finishes* on a
 * completely different one (`GET /callback`) — different connection, no shared
 * closure. `state` is the only thing tying them together, and a third request
 * (`GET /wait/:state`) can block on the result from yet another place.
 *
 *   node index.js
 *   open http://localhost:3000
 */
import { createServer } from 'node:http'
import { createAuthClient, isOAuthError, memoryStorage, publicClientIds } from '@ai-oauth-sdk/core'

const PORT = Number(process.env.PORT ?? 3000)
const ORIGIN = `http://localhost:${PORT}`

// One shared storage means every request sees the same pending flows. Swap for
// Redis or a database and this works across several server processes too.
const client = createAuthClient({
  provider: process.env.PROVIDER ?? 'openai',
  // CLIENT_ID wins; otherwise the id that provider's own CLI publishes.
  clientId: process.env.CLIENT_ID ?? publicClientIds[process.env.PROVIDER ?? 'openai'],
  redirectUri: `${ORIGIN}/callback`,
  storage: memoryStorage(),
})

const html = (body) =>
  `<!doctype html><meta charset="utf-8"><title>ai-oauth-sdk</title>
   <style>body{font:16px/1.6 ui-sans-serif,system-ui;max-width:44rem;margin:4rem auto;padding:0 1rem}
   code{background:#0001;padding:.15em .4em;border-radius:4px}</style>${body}`

const server = createServer(async (request, response) => {
  const url = new URL(request.url, ORIGIN)

  try {
    // ── 1. Start a flow ─────────────────────────────────────────────────────
    if (url.pathname === '/login') {
      const { url: authorizeUrl, state } = await client.createAuthorization({
        // Anything here comes back untouched when the flow completes.
        metadata: { startedAt: new Date().toISOString() },
      })
      // Hand the caller the state so it can poll /wait/:state independently.
      response.writeHead(302, { Location: authorizeUrl, 'X-Auth-State': state })
      response.end()
      return
    }

    // ── 2. Finish it, on a different request ────────────────────────────────
    if (url.pathname === '/callback') {
      // completeAuthorization looks the pending record up by `state`, verifies
      // it, and exchanges the code — no shared state with /login needed.
      const tokens = await client.completeAuthorization({ callbackUrl: request.url })
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(
        html(`<h1>Signed in</h1>
              <p>Account: <code>${tokens.email ?? tokens.accountId ?? 'unknown'}</code></p>
              <p>Token expires: <code>${
                tokens.expiresAt ? new Date(tokens.expiresAt).toLocaleString() : 'n/a'
              }</code></p>
              <p><a href="/">Back</a></p>`),
      )
      return
    }

    // ── 3. Block on the result, from a third place ──────────────────────────
    if (url.pathname.startsWith('/wait/')) {
      const state = url.pathname.slice('/wait/'.length)
      // Resolves whether the callback has already landed or is still pending.
      const tokens = await client.waitForAuthorization(state, { timeoutMs: 120_000 })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ accountId: tokens.accountId, email: tokens.email }, null, 2))
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      html(`<h1>ai-oauth-sdk — server callback</h1>
            <p>Provider: <code>${client.provider.label}</code></p>
            <p><a href="/login">Sign in</a></p>
            <p>The flow starts on <code>/login</code> and finishes on
               <code>/callback</code> — a different request entirely. They are
               correlated only by <code>state</code>.</p>`),
    )
  } catch (error) {
    const status = isOAuthError(error) ? 400 : 500
    response.writeHead(status, { 'Content-Type': 'text/html' })
    response.end(html(`<h1>Sign-in failed</h1><p><code>${error.message}</code></p>`))
  }
})

server.listen(PORT, () => console.log(`Listening on ${ORIGIN}`))
