import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { base64UrlEncode, utf8Encode } from '../../src/crypto/encoding.js'
import { sha256 } from '../../src/crypto/sha256.js'

export interface DeviceFlowOptions {
  /** Polls to answer `authorization_pending` before succeeding. */
  pendingPolls?: number
  /** Answer `slow_down` on the first poll, to exercise backoff. */
  slowDownOnce?: boolean
  /** Seconds the device code is valid. */
  expiresIn?: number
  /** Server-suggested poll interval, in seconds. */
  interval?: number
  /** Terminate the flow with this error instead of succeeding. */
  failWith?: string
  /**
   * Refuse a device request that carries no `code_challenge`, and a poll whose
   * `code_verifier` does not derive from it. Qwen behaves exactly this way.
   */
  requirePkce?: boolean
  /** Answer the first poll with a 5xx from a gateway rather than an OAuth error. */
  gatewayErrorOnce?: boolean
  /** Answer *every* poll with a gateway 5xx, as a proxy that is simply down would. */
  gatewayErrorAlways?: boolean
}

export interface FakeAuthServerOptions {
  /** Enables `/device/code` and device-grant handling on `/token`. */
  device?: DeviceFlowOptions
  /** Reject the code exchange with this OAuth error. */
  failWith?: string
  /** Seconds until the issued access token expires. */
  expiresIn?: number
  /** Issue an id_token carrying these claims. */
  idTokenClaims?: Record<string, unknown>
  /** Extra fields merged into the token response. */
  extraTokenFields?: Record<string, unknown>
  /** Omit refresh_token from refresh responses (many providers do). */
  omitRefreshOnRenew?: boolean
  /** Delay every token response by this many ms. */
  delayMs?: number
}

export interface FakeAuthServer {
  url: string
  /** Every token-endpoint request body received, in order. */
  requests: Array<Record<string, string>>
  /** Codes handed out by `authorize`, mapped to their PKCE challenge. */
  issuedCodes: Map<string, { challenge?: string; method?: string }>
  /** Headers seen by `/api/echo`, in order. */
  apiRequests: Array<Record<string, string>>
  /** Request targets seen by the protected API, in order, path and query. */
  apiUrls: string[]
  /** Request bodies seen by the protected API, in order. */
  apiBodies: string[]
  /** Bodies posted to `/revoke`, in order. */
  revocations: Array<Record<string, string>>
  /** Bodies posted to `/device/code`, in order. */
  deviceRequests: Array<Record<string, string>>
  tokenCount: number
  refreshCount: number
  apiCount: number
  /** Number of device-grant polls received. */
  devicePolls: number
  /** The most recently issued access token; `/api/echo` rejects anything else. */
  currentAccessToken: string | undefined
  close(): Promise<void>
}

function fakeJwt(claims: Record<string, unknown>): string {
  const header = base64UrlEncode(utf8Encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))
  const payload = base64UrlEncode(utf8Encode(JSON.stringify(claims)))

  return `${header}.${payload}.`
}

/**
 * A minimal OAuth 2.0 authorization server, enough to exercise the real code
 * paths end to end: it validates PKCE properly (recomputing S256 from the
 * verifier), rotates refresh tokens, and can be told to fail.
 */
export async function startFakeAuthServer(
  options: FakeAuthServerOptions = {},
): Promise<FakeAuthServer> {
  const requests: Array<Record<string, string>> = []
  const apiRequests: Array<Record<string, string>> = []
  const apiUrls: string[] = []
  const apiBodies: string[] = []
  const revocations: Array<Record<string, string>> = []
  const issuedCodes = new Map<string, { challenge?: string; method?: string }>()
  let tokenCount = 0
  let refreshCount = 0
  let apiCount = 0
  let issuedRefresh = 0
  let currentAccessToken: string | undefined
  let revoked = false
  let openrouterChallenge: string | undefined
  let deviceChallenge: string | undefined
  let devicePolls = 0
  const deviceRequests: Array<Record<string, string>> = []

  const server: Server = createServer(async (request, response) => {
    // Node hands a malformed request target to the listener rather than
    // rejecting it itself, and a throw from here would take the whole test
    // worker down rather than failing one assertion.
    let url: URL

    try {
      url = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      response.writeHead(400)
      response.end()

      return
    }

    // authorization endpoint
    if (url.pathname === '/authorize') {
      const code = `code-${issuedCodes.size + 1}`
      const challenge = url.searchParams.get('code_challenge')
      const method = url.searchParams.get('code_challenge_method')
      issuedCodes.set(code, {
        ...(challenge ? { challenge } : {}),
        ...(method ? { method } : {}),
      })
      const redirectUri = url.searchParams.get('redirect_uri')!
      const state = url.searchParams.get('state') ?? ''
      const location = new URL(redirectUri)
      location.searchParams.set('code', code)
      location.searchParams.set('state', state)
      response.writeHead(302, { Location: location.toString() })
      response.end()

      return
    }

    // device authorization (RFC 8628)
    if (url.pathname === '/device/code') {
      const device = options.device ?? {}
      const body = await new Promise<string>((resolve) => {
        let data = ''
        request.on('data', (chunk) => (data += chunk))
        request.on('end', () => resolve(data))
      })
      const params = Object.fromEntries(new URLSearchParams(body))
      deviceRequests.push(params)
      deviceChallenge = params['code_challenge']

      if (device.requirePkce && !deviceChallenge) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ detail: 'code_challenge is required for PKCE' }))

        return
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          device_code: 'device-code-1',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://example.test/device',
          verification_uri_complete: 'https://example.test/device?code=WXYZ-1234',
          expires_in: device.expiresIn ?? 900,
          /* An interval of 0 keeps tests fast. */
          interval: device.interval ?? 0,
        }),
      )

      return
    }

    // OpenRouter-shaped, non-standard flow
    // Redirects to `callback_url` with no `state`, and exchanges for `{ key }`.
    if (url.pathname === '/openrouter/auth') {
      const callbackUrl = url.searchParams.get('callback_url')
      openrouterChallenge = url.searchParams.get('code_challenge') ?? undefined
      const location = new URL(callbackUrl!)
      location.searchParams.set('code', 'or-code-1')
      response.writeHead(302, { Location: location.toString() })
      response.end()

      return
    }

    if (url.pathname === '/openrouter/keys') {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        request.on('data', (chunk) => (data += chunk))
        request.on('end', () => resolve(data))
      })
      const params = JSON.parse(body || '{}') as Record<string, string>
      requests.push(params)

      if (openrouterChallenge) {
        const expected = base64UrlEncode(sha256(utf8Encode(params['code_verifier'] ?? '')))

        if (expected !== openrouterChallenge) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_grant' }))

          return
        }
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ key: 'sk-or-v1-userkey' }))

      return
    }

    // protected API
    // Rejects anything but the newest access token, so a 401-then-refresh
    // retry can be exercised for real rather than simulated.
    if (url.pathname === '/api/echo' || url.pathname === '/api/responses') {
      apiCount++
      apiRequests.push(request.headers as Record<string, string>)
      apiUrls.push(request.url ?? '')
      apiBodies.push(
        await new Promise<string>((resolve) => {
          let data = ''
          request.on('data', (chunk) => (data += chunk))
          request.on('end', () => resolve(data))
        }),
      )
      const authorization = request.headers.authorization ?? ''
      const presented = authorization.replace(/^Bearer\s+/i, '')

      if (!currentAccessToken || presented !== currentAccessToken) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid_token' }))

        return
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, headers: request.headers, method: request.method }))

      return
    }

    // revocation (RFC 7009)
    if (url.pathname === '/revoke') {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        request.on('data', (chunk) => (data += chunk))
        request.on('end', () => resolve(data))
      })
      revocations.push(Object.fromEntries(new URLSearchParams(body)))
      revoked = true
      currentAccessToken = undefined
      response.writeHead(200)
      response.end()

      return
    }

    if (url.pathname === '/userinfo') {
      const authorization = request.headers.authorization ?? ''

      if (!currentAccessToken || !authorization.includes(currentAccessToken)) {
        response.writeHead(401)
        response.end()

        return
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ sub: 'user-1', email: 'dev@example.com', name: 'Dev' }))

      return
    }

    // token endpoint
    if (url.pathname === '/token') {
      const body = await new Promise<string>((resolve) => {
        let data = ''
        request.on('data', (chunk) => (data += chunk))
        request.on('end', () => resolve(data))
      })

      const contentType = request.headers['content-type'] ?? ''
      const params: Record<string, string> = contentType.includes('json')
        ? (JSON.parse(body || '{}') as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(body))
      requests.push(params)

      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs))
      }

      if (options.failWith) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: options.failWith, error_description: 'fake failure' }))

        return
      }

      // device grant polling
      if (params['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
        const device = options.device ?? {}
        devicePolls++

        if (device.gatewayErrorAlways || (device.gatewayErrorOnce && devicePolls === 1)) {
          // Not JSON, and not an OAuth error — a proxy in front of the provider.
          response.writeHead(504, { 'Content-Type': 'text/html' })
          response.end('<html><body><h1>504 Gateway Time-out</h1></body></html>')

          return
        }

        if (device.requirePkce) {
          const verifier = params['code_verifier'] ?? ''
          const derived = base64UrlEncode(await sha256(utf8Encode(verifier)))

          if (!verifier || derived !== deviceChallenge) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant' }))

            return
          }
        }

        if (device.slowDownOnce && devicePolls === 1) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'slow_down' }))

          return
        }

        const pendingPolls = device.pendingPolls ?? 0
        const effectivePoll = device.slowDownOnce ? devicePolls - 1 : devicePolls

        if (effectivePoll <= pendingPolls) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'authorization_pending' }))

          return
        }

        if (device.failWith) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: device.failWith }))

          return
        }

        tokenCount++
        currentAccessToken = `access-${tokenCount + refreshCount}`
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            access_token: currentAccessToken,
            refresh_token: 'device-refresh-1',
            expires_in: options.expiresIn ?? 3600,
            token_type: 'Bearer',
          }),
        )

        return
      }

      const isRefresh = params['grant_type'] === 'refresh_token'

      if (isRefresh) {
        refreshCount++

        // A revoked session cannot be refreshed back to life.
        if (revoked) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }))

          return
        }
      } else {
        tokenCount++
        // Verify PKCE the way a real server does.
        const record = issuedCodes.get(params['code'] ?? '')

        if (!record) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown code' }))

          return
        }

        if (record.challenge) {
          const verifier = params['code_verifier']

          if (!verifier) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_request', error_description: 'missing verifier' }))

            return
          }

          const expected =
            record.method === 'plain' ? verifier : base64UrlEncode(sha256(utf8Encode(verifier)))

          if (expected !== record.challenge) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }))

            return
          }
        }
      }

      const includeRefresh = !isRefresh || !options.omitRefreshOnRenew

      if (includeRefresh) {
        issuedRefresh++
      }

      currentAccessToken = `access-${tokenCount + refreshCount}`

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          access_token: currentAccessToken,
          ...(includeRefresh ? { refresh_token: `refresh-${issuedRefresh}` } : {}),
          expires_in: options.expiresIn ?? 3600,
          token_type: 'Bearer',
          scope: params['scope'] ?? 'openid profile',
          ...(options.idTokenClaims ? { id_token: fakeJwt(options.idTokenClaims) } : {}),
          ...options.extraTokenFields,
        }),
      )

      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    apiRequests,
    apiUrls,
    apiBodies,
    revocations,
    deviceRequests,
    issuedCodes,
    get tokenCount() {
      return tokenCount
    },
    get refreshCount() {
      return refreshCount
    },
    get apiCount() {
      return apiCount
    },
    get devicePolls() {
      return devicePolls
    },
    get currentAccessToken() {
      return currentAccessToken
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
