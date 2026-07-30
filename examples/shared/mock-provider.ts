import { createHash, randomBytes } from 'node:crypto'
import type { Plugin } from 'vite'

/**
 * A miniature OAuth 2.0 provider, served by Vite alongside the app.
 *
 * The browser examples exist to show how the bindings are wired, and they can
 * only do that if you can actually click "Sign in" and watch it work. Pointing
 * them at a real provider would not achieve that: the ids in `publicClientIds`
 * are registered for *loopback* redirects, not web origins, so a real provider
 * would reject `http://localhost:5173/callback.html` before the demo started.
 *
 * So the examples talk to this instead. It is a real authorization-code + PKCE
 * flow — it verifies the S256 challenge and refuses a mismatch — just with a
 * fake consent screen and fake tokens. Swapping in a real provider is a
 * two-line change, described in each example's README.
 */
export function mockProvider(): Plugin {
  /** code → the challenge it was issued against. */
  const issued = new Map<string, string | undefined>()
  let issuedTokens = 0

  const consentPage = (params: URLSearchParams, approveUrl: string, denyUrl: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock provider — authorize</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif, system-ui, sans-serif;
         background:#f6f7fb; color:#16181d; }
  @media (prefers-color-scheme: dark) { body { background:#0d0f14; color:#e6e8ee; } }
  .card { background:#fff; border-radius:12px; padding:2rem; max-width:26rem;
          box-shadow:0 1px 3px #0001, 0 8px 24px #0000000f; }
  @media (prefers-color-scheme: dark) { .card { background:#171a21; box-shadow:none; border:1px solid #262b36; } }
  h1 { font-size:1.15rem; margin:0 0 .35rem; }
  p { margin:0 0 1.25rem; opacity:.7; font-size:.92rem; }
  dl { margin:0 0 1.5rem; font-size:.8rem; font-family:ui-monospace, monospace; opacity:.6; }
  dt { float:left; width:6.5rem; clear:left; }
  dd { margin:0 0 .2rem 6.5rem; overflow-wrap:anywhere; }
  .row { display:flex; gap:.6rem; }
  a { font:inherit; padding:.6rem 1.1rem; border-radius:8px; flex:1; border:1px solid #0002;
      text-align:center; text-decoration:none; color:inherit; }
  a.primary { background:#3b46c4; color:#fff; border-color:transparent; }
</style>
</head>
<body>
  <div class="card">
    <h1>Mock provider</h1>
    <p>Not a real provider — this is Vite pretending, so the example runs offline.</p>
    <dl>
      <dt>client_id</dt><dd>${escapeHtml(params.get('client_id') ?? '(none)')}</dd>
      <dt>scope</dt><dd>${escapeHtml(params.get('scope') ?? '(none)')}</dd>
      <dt>PKCE</dt><dd>${params.get('code_challenge') ? 'S256 challenge present' : 'none'}</dd>
    </dl>
    <div class="row">
      <!-- Anchors, not buttons with inline onclick: these URLs carry &-separated
           query params and quotes, which an HTML attribute would mangle. -->
      <a href="${escapeHtml(denyUrl)}" role="button">Deny</a>
      <a class="primary" href="${escapeHtml(approveUrl)}" role="button">Approve</a>
    </div>
  </div>
</body>
</html>`

  return {
    name: 'aioauth-mock-provider',
    configureServer(server) {
      server.middlewares.use('/mock/authorize', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const params = url.searchParams
        const redirectUri = params.get('redirect_uri')
        if (!redirectUri) {
          response.statusCode = 400
          response.end('missing redirect_uri')
          return
        }

        const code = `mock-code-${randomBytes(6).toString('hex')}`
        issued.set(code, params.get('code_challenge') ?? undefined)

        const approve = new URL(redirectUri)
        approve.searchParams.set('code', code)
        if (params.get('state')) {
          approve.searchParams.set('state', params.get('state')!)
        }

        const deny = new URL(redirectUri)
        deny.searchParams.set('error', 'access_denied')
        deny.searchParams.set('error_description', 'You clicked Deny on the mock consent screen.')
        if (params.get('state')) {
          deny.searchParams.set('state', params.get('state')!)
        }

        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(consentPage(params, approve.toString(), deny.toString()))
      })

      server.middlewares.use('/mock/token', (request, response) => {
        let body = ''
        request.on('data', (chunk) => (body += chunk))
        request.on('end', () => {
          const params = new URLSearchParams(body)
          const json = (status: number, payload: unknown) => {
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(payload))
          }

          if (params.get('grant_type') === 'refresh_token') {
            issuedTokens++
            return json(200, tokenResponse(issuedTokens))
          }

          const code = params.get('code') ?? ''
          if (!issued.has(code)) {
            return json(400, { error: 'invalid_grant', error_description: 'unknown code' })
          }

          // Verify PKCE the way a real provider does — a broken verifier must
          // fail here, not silently pass.
          const challenge = issued.get(code)
          issued.delete(code)
          if (challenge) {
            const verifier = params.get('code_verifier')
            if (!verifier) {
              return json(400, { error: 'invalid_request', error_description: 'missing code_verifier' })
            }
            const expected = createHash('sha256').update(verifier).digest('base64url')
            if (expected !== challenge) {
              return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
            }
          }

          issuedTokens++
          json(200, tokenResponse(issuedTokens))
        })
      })
    },
  }
}

function tokenResponse(n: number) {
  return {
    access_token: `mock-access-token-${n}`,
    refresh_token: 'mock-refresh-token',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid profile email',
    // The examples read `email` off the TokenSet; the mock provider supplies it
    // the way Anthropic does, in the body rather than an id_token.
    account: { uuid: 'mock-account-1', email_address: 'you@example.com' },
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
