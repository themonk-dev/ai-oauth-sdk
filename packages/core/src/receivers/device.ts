import { createDefaultCrypto, type CryptoAdapter } from '../crypto/adapter.js'
import { OAuthError } from '../errors.js'
import { createPkce } from '../pkce.js'
import { encodeQuery, parseQuery } from '../query.js'
import { fetchWithSignal } from '../http.js'
import { safeSnippet } from '../redact.js'
import { readExpiresIn } from '../token.js'
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

/** A non-empty string, or nothing. Keeps the `??` chains below readable. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Pulls the error a poll response *names* out of it, without quoting the body.
 *
 * Three shapes get here. The conventional `{"error":…,"error_description":…}`;
 * OpenAI's nested `{"error":{"type":…,"message":…}}`, which `readTokenError`
 * unwraps on the redirect path; and a form-encoded body, which never parsed as
 * JSON at all — `form` is the text only when `JSON.parse` threw, and only its
 * `error` and `error_description` keys are ever read out of it.
 *
 * Both the untransformed body and the provider's transform of it are consulted,
 * in that order: a normaliser written for the success shape usually returns the
 * token fields alone and drops `error` on the floor, but one that moves the
 * code into the standard field should be honoured too.
 *
 * Values come back exactly as the provider sent them. The caller compares them
 * against the spec codes and redacts on the way out — same rule as
 * `readTokenError`, for the same reason.
 */
function readPollError(
  raw: Record<string, unknown>,
  parsed: Record<string, unknown>,
  form: string,
): { error?: string; description?: string } {
  const nested =
    typeof raw['error'] === 'object' && raw['error'] !== null
      ? (raw['error'] as Record<string, unknown>)
      : undefined
  const encoded = form ? parseQuery(form) : {}

  return {
    error:
      stringField(raw['error']) ??
      stringField(parsed['error']) ??
      stringField(nested?.['type']) ??
      stringField(nested?.['code']) ??
      stringField(encoded['error']),
    description:
      stringField(raw['error_description']) ??
      stringField(parsed['error_description']) ??
      stringField(nested?.['message']) ??
      stringField(encoded['error_description']),
  }
}

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
 * A successful body is shaped by the same provider hooks the redirect path
 * uses — `parseTokenResponse` then `enrichTokens` — so a device login and a
 * redirect login of the same account store the same {@link TokenSet}.
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
      },
      input.signal,
      'Device authorization polling was aborted.',
    )
    const text = await response.text().catch(() => '')
    let raw: Record<string, unknown> = {}
    let isJson = false

    try {
      const decoded: unknown = JSON.parse(text)

      // `'null'`, `'3'` and `'"x"'` all parse without throwing, and a bare
      // `null` would then make every `raw[...]` read below a TypeError rather
      // than a poll failure. Only an object is a token response.
      if (typeof decoded === 'object' && decoded !== null) {
        raw = decoded as Record<string, unknown>
        isJson = true
      }
    } catch {
      raw = {}
    }

    // Same shaping the redirect path applies, in the same order: the provider's
    // `parseTokenResponse` runs on a success body *before* anything is read out
    // of it, and only there, because a provider with a non-standard success
    // shape may still report errors the conventional way — so the error below
    // is read from the untransformed body first, and from the transform only as
    // a fallback. Skipping the transform entirely read an unconventional 200 as
    // a failure and quoted the body — a live credential — into the error below,
    // while burning the grant it described.
    const parsed =
      response.ok && provider.parseTokenResponse ? provider.parseTokenResponse(raw) : raw
    const accessToken = parsed['access_token']

    if (response.ok && typeof accessToken === 'string' && accessToken) {
      // `readExpiresIn` rather than a bare `typeof === 'number'`: a provider
      // that sends the digits as a JSON string would otherwise leave the grant
      // with no `expiresAt` at all, and `isExpired` reads a missing one as
      // "never expires". Same coercion the redirect path applies.
      const expiresIn = readExpiresIn(parsed['expires_in'])
      const tokens: TokenSet = {
        accessToken,
        ...(typeof parsed['refresh_token'] === 'string' && parsed['refresh_token']
          ? { refreshToken: parsed['refresh_token'] }
          : {}),
        ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn * 1000 }),
        tokenType: typeof parsed['token_type'] === 'string' ? parsed['token_type'] : 'Bearer',
        ...(typeof parsed['scope'] === 'string' ? { scope: parsed['scope'] } : {}),
        ...(typeof parsed['id_token'] === 'string' ? { idToken: parsed['id_token'] } : {}),
        provider: provider.id,
        raw: parsed,
      }
      const enriched = provider.enrichTokens?.(parsed, tokens)

      return enriched ? { ...tokens, ...enriched } : tokens
    }

    const failure = readPollError(raw, parsed, isJson ? '' : text)
    // What the loop does next is decided by the code the *server* sent, not by
    // what survived the provider's transform: a normaliser returning the four
    // token fields drops `error`, and a provider that answers a pending grant
    // with HTTP 200 — GitHub's device endpoint does — then came out of the
    // transform naming nothing, so poll #1 reported `invalid_token_response`
    // before the user had a chance to approve. `slow_down` at 200 was lost the
    // same way.
    const error = stringField(raw['error']) ?? stringField(parsed['error']) ?? 'unknown_error'

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

    // A 200 that names nothing at all — no `error`, no `error_description`, in
    // any of the shapes above — and still could not be shaped into a token. As
    // far as the provider is concerned this body is a *successful* token
    // response, so it may be the credential itself: say what is missing and
    // quote nothing. `redact.ts` matches known parameter names and known token
    // shapes; an unrecognised secret under an unrecognised key is neither, and
    // the 120-character cap is not a redaction.
    //
    // A 200 that *does* name one is a described failure, not an unreadable
    // body, and stays `device_flow_failed`: the CLI hangs its
    // `devicePrerequisite` hint off that code, and suppressing the body is no
    // reason to throw away the two fields that say what went wrong.
    if (response.ok && !failure.error && !failure.description) {
      throw new OAuthError(
        'invalid_token_response',
        `Device token response for "${provider.id}" did not include an access_token.`,
        { status: response.status },
      )
    }

    // The body snippet is the last resort, and only for a status that already
    // says failure: on a 200 the body is the provider's idea of success and may
    // carry the credential, so an error it *names* is quoted and the body
    // around it is not.
    const fallback = response.ok ? '' : safeSnippet(text, 120)
    const detail = failure.description ? safeSnippet(failure.description, 120) : fallback
    // `error` is the provider's string too, so it gets the same treatment as
    // the description beside it — a gateway that reflects the request back puts
    // the `device_code` and `code_verifier` we just posted into this field, and
    // it was the one place here quoting a response verbatim. Redacted only on
    // the way out: the comparisons above must keep matching the raw value, not
    // a value that happens to survive `safeSnippet` because spec codes are
    // short. Same rule as `readTokenError`.
    const reported = safeSnippet(failure.error ?? error, 120)
    throw new OAuthError(
      'device_flow_failed',
      `Device authorization failed: ${reported}${detail ? ` (${detail})` : ''}`,
      { providerError: reported, status: response.status },
    )
  }

  throw new OAuthError('timeout', 'Device code expired before the user approved it.')
}
