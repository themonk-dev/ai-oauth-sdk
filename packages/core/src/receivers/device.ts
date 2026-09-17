import { createDefaultCrypto, type CryptoAdapter } from '../crypto/adapter.js'
import { OAuthError } from '../errors.js'
import { createPkce } from '../pkce.js'
import { encodeQuery } from '../query.js'
import { fetchWithSignal } from '../http.js'
import { safeSnippet } from '../redact.js'
import type { DeviceCodeResponse, FetchLike, ProviderConfig, TokenSet } from '../types.js'

export type { DeviceCodeResponse } from '../types.js'

/** Reads a numeric field from an untrusted response, bounded and with a default. */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(Math.max(value, min), max)
}

export interface StartDeviceAuthorizationInput {
  provider: ProviderConfig
  clientId: string
  scopes?: string[]
  fetchImpl?: FetchLike
  signal?: AbortSignal
  crypto?: CryptoAdapter
}

/**
 * Opens an RFC 8628 device authorization grant.
 *
 * Not a {@link CallbackReceiver} — there is no redirect at all. The user opens
 * a URL on a *different* device and types a short code, while this side polls
 * the token endpoint. That makes it the right choice for containers and SSH
 * sessions where no browser can reach back to the client.
 *
 * PKCE goes on the request even though RFC 8628 says nothing about it: the
 * device code is handed to a user who types it on another machine, so binding
 * the exchange to this process is worth two extra parameters — and Qwen refuses
 * the request outright without them ("code_challenge is required for PKCE").
 *
 * `expires_in` and `interval` are clamped because they come from the server.
 * `interval: 0` is a valid number and taking it literally turns the poll loop
 * into an unthrottled flood of the token endpoint, while the ceiling stops a
 * broken server pinning us to one request a minute. A short `expires_in` needs
 * no floor — it simply ends the loop, which is the server's call to make.
 */
export async function startDeviceAuthorization(
  input: StartDeviceAuthorizationInput,
): Promise<DeviceCodeResponse> {
  const { provider } = input

  if (!provider.deviceAuthorizationUrl) {
    throw new OAuthError(
      'configuration_error',
      `Provider "${provider.id}" does not declare a device authorization endpoint.`,
    )
  }

  const pkce = provider.usePkce
    ? await createPkce(input.crypto ?? createDefaultCrypto(), provider.pkceMethod)
    : undefined

  const body = encodeQuery({
    client_id: input.clientId,
    scope: (input.scopes ?? provider.scopes).join(' '),
    ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: pkce.method } : {}),
  })

  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const response = await fetchWithSignal(
    fetchImpl,
    provider.deviceAuthorizationUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      // No redirect following on a request whose body is a credential — see the
      // reasoning on `postToTokenEndpoint` in token.ts. This body carries the
      // client id and the PKCE challenge, and the response decides the URL the
      // user is told to trust, so a followed hop chooses both.
      redirect: 'error',
    },
    input.signal,
    'Device authorization request was aborted.',
  )

  if (!response.ok) {
    const detail = safeSnippet(await response.text().catch(() => ''))
    throw new OAuthError(
      'device_flow_failed',
      `Device authorization request failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
      { status: response.status },
    )
  }

  const raw = (await response.json()) as Record<string, unknown>
  const deviceCode = raw['device_code']
  const userCode = raw['user_code']
  const verificationUri = raw['verification_uri'] ?? raw['verification_url']

  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new OAuthError('device_flow_failed', 'Device authorization response was missing required fields.')
  }

  const expiresIn = clamp(raw['expires_in'], 900, 0, 24 * 60 * 60)
  const interval = clamp(raw['interval'], 5, 1, 60)

  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof raw['verification_uri_complete'] === 'string'
      ? { verificationUriComplete: raw['verification_uri_complete'] }
      : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: interval * 1000,
    ...(pkce ? { codeVerifier: pkce.verifier } : {}),
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new OAuthError('aborted', 'Device authorization polling was aborted.'))
    }

    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new OAuthError('aborted', 'Device authorization polling was aborted.'))

      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Consecutive 5xx responses tolerated before polling gives up and reports one. */
const MAX_SERVER_ERRORS = 3

/**
 * Added per 5xx. Much smaller than the `slow_down` step, because the server's
 * own `interval` already paces us and a gateway blip does not mean we are
 * polling too fast — it only has to survive a few seconds of restart.
 */
const SERVER_ERROR_BACKOFF_MS = 1_000

export interface PollDeviceTokenInput {
  provider: ProviderConfig
  clientId: string
  device: DeviceCodeResponse
  fetchImpl?: FetchLike
  signal?: AbortSignal
  onPoll?: (attempt: number) => void
}

/**
 * Polls until the user approves, honouring the server's `interval` and backing
 * off on `slow_down` as the RFC requires — polling faster gets you rate limited.
 *
 * Each response is read as text before being parsed, because a gateway sitting
 * in front of the token endpoint answers with an HTML error page; parsing that
 * straight to `{}` would report `unknown_error` for what is really a 504 from
 * someone's proxy. For the same reason a 5xx keeps polling: it is the
 * provider's infrastructure talking, not a verdict on the grant, and giving up
 * would throw away a code the user may already have approved.
 *
 * That tolerance is bounded at {@link MAX_SERVER_ERRORS}. A gateway that is
 * simply down answers every poll, and retrying to the device code's expiry
 * would block for a quarter of an hour and then report a timeout — telling the
 * user they were too slow to approve when the truth was a 502 all along.
 */
export async function pollDeviceToken(input: PollDeviceTokenInput): Promise<TokenSet> {
  const { provider, device } = input
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let intervalMs = device.intervalMs
  let attempt = 0
  let serverErrors = 0

  while (Date.now() < device.expiresAt) {
    await sleep(intervalMs, input.signal)
    input.onPoll?.(++attempt)

    const body = encodeQuery({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.deviceCode,
      client_id: input.clientId,
      ...(device.codeVerifier ? { code_verifier: device.codeVerifier } : {}),
    })

    const response = await fetchWithSignal(
      fetchImpl,
      provider.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        // Same guard as token.ts, and the sharpest instance of it: this is a
        // loop carrying `device_code` and `code_verifier`, firing every few
        // seconds for up to a quarter of an hour, so one 308 exfiltrates the
        // grant repeatedly rather than once.
        redirect: 'error',
      },
      input.signal,
      'Device authorization polling was aborted.',
    )
    const text = await response.text().catch(() => '')
    let raw: Record<string, unknown> = {}

    try {
      raw = JSON.parse(text) as Record<string, unknown>
    } catch {
      raw = {}
    }

    if (response.ok && typeof raw['access_token'] === 'string') {
      return {
        accessToken: raw['access_token'],
        ...(typeof raw['refresh_token'] === 'string' ? { refreshToken: raw['refresh_token'] } : {}),
        ...(typeof raw['expires_in'] === 'number'
          ? { expiresAt: Date.now() + raw['expires_in'] * 1000 }
          : {}),
        tokenType: typeof raw['token_type'] === 'string' ? raw['token_type'] : 'Bearer',
        ...(typeof raw['scope'] === 'string' ? { scope: raw['scope'] } : {}),
        ...(typeof raw['id_token'] === 'string' ? { idToken: raw['id_token'] } : {}),
        provider: provider.id,
        raw,
      }
    }

    const error = typeof raw['error'] === 'string' ? raw['error'] : 'unknown_error'

    if (error === 'authorization_pending') {
      continue
    }

    if (error === 'slow_down') {
      intervalMs += 5_000
      continue
    }

    if (response.status >= 500 && error === 'unknown_error' && serverErrors < MAX_SERVER_ERRORS) {
      serverErrors++
      intervalMs += SERVER_ERROR_BACKOFF_MS
      continue
    }

    const described = raw['error_description']
    const detail =
      typeof described === 'string' && described
        ? safeSnippet(described, 120)
        : safeSnippet(text, 120)
    // `error` is the provider's string too, so it gets the same treatment as
    // the description beside it — a gateway that reflects the request back puts
    // the `device_code` and `code_verifier` we just posted into this field, and
    // it was the one place here quoting a response verbatim. Redacted only on
    // the way out: the comparisons above must keep matching the raw value, not
    // a value that happens to survive `safeSnippet` because spec codes are
    // short. Same rule as `readTokenError`.
    const reported = safeSnippet(error, 120)
    throw new OAuthError(
      'device_flow_failed',
      `Device authorization failed: ${reported}${detail ? ` (${detail})` : ''}`,
      { providerError: reported, status: response.status },
    )
  }

  throw new OAuthError('timeout', 'Device code expired before the user approved it.')
}
