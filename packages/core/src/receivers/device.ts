import { OAuthError } from '../errors.js'
import { encodeQuery } from '../query.js'
import { fetchWithSignal } from '../http.js'
import type { FetchLike, ProviderConfig, TokenSet } from '../types.js'

/**
 * RFC 8628 device authorization grant.
 *
 * Not a {@link CallbackReceiver} — there is no redirect at all. The user opens
 * a URL on a *different* device and types a short code, while this side polls
 * the token endpoint. That makes it the right choice for TVs, containers, and
 * SSH sessions where no browser can reach back to the client.
 */
export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Pre-filled variant, when the provider supplies one. */
  verificationUriComplete?: string
  expiresAt: number
  intervalMs: number
}

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
}

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

  const body = encodeQuery({
    client_id: input.clientId,
    scope: (input.scopes ?? provider.scopes).join(' '),
  })

  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const response = await fetchWithSignal(
    fetchImpl,
    provider.deviceAuthorizationUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    },
    input.signal,
    'Device authorization request was aborted.',
  )

  if (!response.ok) {
    throw new OAuthError(
      'device_flow_failed',
      `Device authorization request failed (HTTP ${response.status}).`,
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

  // `interval: 0` is a number, and taking it literally turns the poll loop into
  // an unthrottled flood of the token endpoint; the ceiling stops a broken
  // server pinning us to one request a minute. A short `expires_in` needs no
  // floor — it simply ends the loop, which is the server's call to make.
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
 */
export async function pollDeviceToken(input: PollDeviceTokenInput): Promise<TokenSet> {
  const { provider, device } = input
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let intervalMs = device.intervalMs
  let attempt = 0

  while (Date.now() < device.expiresAt) {
    await sleep(intervalMs, input.signal)
    input.onPoll?.(++attempt)

    const body = encodeQuery({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.deviceCode,
      client_id: input.clientId,
    })

    const response = await fetchWithSignal(
      fetchImpl,
      provider.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      },
      input.signal,
      'Device authorization polling was aborted.',
    )
    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>

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
    throw new OAuthError('device_flow_failed', `Device authorization failed: ${error}`, {
      providerError: error,
      status: response.status,
    })
  }

  throw new OAuthError('timeout', 'Device code expired before the user approved it.')
}
