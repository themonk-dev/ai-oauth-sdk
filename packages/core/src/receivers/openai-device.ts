import { OAuthError } from '../errors.js'
import { fetchWithSignal } from '../http.js'
import { REDACTED, safeSnippet } from '../redact.js'
import { exchangeCode } from '../token.js'
import type { DeviceFlow, DeviceFlowPollInput, DeviceFlowStartInput, FetchLike } from '../types.js'
import { clamp } from './device.js'

/**
 * OpenAI's headless sign-in — the one behind `codex login --device-auth`.
 *
 * It looks like a device flow and is not RFC 8628. The differences all matter:
 *
 * - request and poll bodies are JSON, not form encoding
 * - "not approved yet" is HTTP 403 or 404, not `error=authorization_pending`
 * - the codes are `device_auth_id` + `user_code`, not a single `device_code`
 * - approval yields an *authorization code* plus **the PKCE verifier the
 *   server generated**, which then goes through the ordinary token endpoint
 *   against a fixed hosted redirect
 *
 * Verified against the live endpoints on 2026-07-31.
 */
const ISSUER = 'https://auth.openai.com'
const USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`
const POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`
const VERIFICATION_URI = `${ISSUER}/codex/device`
/** Fixed by OpenAI for this flow; the exchange is rejected without it. */
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`

const DEFAULT_INTERVAL_SECONDS = 5
const DEFAULT_EXPIRY_SECONDS = 15 * 60
const MIN_INTERVAL_SECONDS = 1
const MAX_INTERVAL_SECONDS = 60
const MAX_EXPIRY_SECONDS = 24 * 60 * 60

/**
 * Shortest value worth scrubbing out of a snippet by value.
 *
 * A blank or near-blank code would otherwise match everywhere and blanket the
 * message, which destroys the diagnostic and tells the reader nothing. Matches
 * the minimum the parameter-name redaction already applies.
 */
const MIN_SCRUBBED_LENGTH = 4

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/**
 * Removes this attempt's own device codes from an untrusted snippet.
 *
 * `device_auth_id` + `user_code` are together the approval credential: posted
 * as a pair to the poll endpoint, they return an authorization code *and* the
 * verifier that redeems it, so anyone reading them out of a log can finish the
 * sign-in. Name-based redaction alone is not enough here, because it needs a
 * `key: value` shape and the leak arrives just as often in the provider's own
 * prose — "device authorization da_01J… for user_code WXYZ-1234 is in an
 * invalid state". We know both literals, so they go by value, before
 * {@link safeSnippet} collapses and truncates.
 */
function scrubDeviceValues(text: string, ...values: string[]): string {
  let out = text

  for (const value of values) {
    if (value.length < MIN_SCRUBBED_LENGTH) {
      continue
    }

    out = out.replace(new RegExp(escapeRegExp(value), 'gi'), REDACTED)
  }

  return out
}

interface UserCodeResponse {
  device_auth_id?: unknown
  user_code?: unknown
  interval?: unknown
  expires_at?: unknown
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<Response> {
  return fetchWithSignal(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
    signal,
    abortMessage,
  )
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new OAuthError('aborted', 'Device authorization polling was aborted.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    if (signal?.aborted) {
      onAbort()

      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Requests a user code.
 *
 * `interval` arrives as a string here, unlike everywhere else. OpenAI returns
 * no pre-filled verification URI either, but its page forwards `user_code`
 * straight through to the authorize step — verified against the live redirect —
 * so the same one-click link xAI hands back can be built here.
 */
async function start(input: DeviceFlowStartInput) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const response = await postJson(
    fetchImpl,
    USERCODE_URL,
    { client_id: input.clientId },
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

  const raw = (await response.json()) as UserCodeResponse
  const deviceAuthId = raw['device_auth_id']
  const userCode = raw['user_code']

  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
    throw new OAuthError(
      'device_flow_failed',
      'Device authorization response was missing device_auth_id or user_code.',
    )
  }

  const interval = Number(raw['interval'])
  const expiresAt = Date.parse(String(raw['expires_at'] ?? ''))
  const now = Date.now()
  // Both fields come from the server, and the RFC 8628 side of the house
  // already bounds its equivalents. A missing or non-positive `interval` keeps
  // falling back to the default, as before; the floor is what stops a tiny
  // positive one (`0.001`) polling flat out, and the ceiling stops a huge one
  // overflowing `setTimeout`'s 32-bit delay, which fires immediately instead of
  // waiting. `expires_at` is bounded the same way for the same reason: it is
  // the poll loop's only exit, so a date in 2099 means the loop never ends.
  const intervalSeconds = clamp(
    interval > 0 ? interval : DEFAULT_INTERVAL_SECONDS,
    DEFAULT_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  )
  const expirySeconds = clamp(
    Number.isFinite(expiresAt) ? (expiresAt - now) / 1000 : DEFAULT_EXPIRY_SECONDS,
    DEFAULT_EXPIRY_SECONDS,
    0,
    MAX_EXPIRY_SECONDS,
  )

  return {
    deviceCode: deviceAuthId,
    userCode,
    verificationUri: VERIFICATION_URI,
    verificationUriComplete: `${VERIFICATION_URI}?user_code=${encodeURIComponent(userCode)}`,
    expiresAt: now + expirySeconds * 1000,
    intervalMs: intervalSeconds * 1000,
  }
}

/**
 * Polls until approval, then runs the second hop.
 *
 * HTTP 403 and 404 are the only "keep waiting" signal this endpoint gives. Once
 * approved, the exchange is an ordinary authorization-code grant — but with the
 * verifier OpenAI generated rather than one we derived.
 */
async function poll(input: DeviceFlowPollInput) {
  const { device, provider } = input
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let attempt = 0

  while (Date.now() < device.expiresAt) {
    await sleep(device.intervalMs, input.signal)
    input.onPoll?.(++attempt)

    const response = await postJson(
      fetchImpl,
      POLL_URL,
      { device_auth_id: device.deviceCode, user_code: device.userCode },
      input.signal,
      'Device authorization polling was aborted.',
    )

    if (response.status === 403 || response.status === 404) {
      continue
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const detail = safeSnippet(scrubDeviceValues(body, device.deviceCode, device.userCode))
      throw new OAuthError(
        'device_flow_failed',
        `Device authorization failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
        { status: response.status },
      )
    }

    const approved = (await response.json()) as Record<string, unknown>
    const code = approved['authorization_code']
    const codeVerifier = approved['code_verifier']

    if (typeof code !== 'string' || typeof codeVerifier !== 'string') {
      throw new OAuthError(
        'device_flow_failed',
        'Device approval response was missing authorization_code or code_verifier.',
      )
    }

    return exchangeCode({
      provider,
      clientId: input.clientId,
      code,
      codeVerifier,
      redirectUri: DEVICE_REDIRECT_URI,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
  }

  throw new OAuthError('timeout', 'Device code expired before the user approved it.')
}

export const openaiDeviceFlow: DeviceFlow = { start, poll }
