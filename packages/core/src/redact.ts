/**
 * Scrubs credentials out of text before it goes into an error message.
 *
 * Error messages end up in application logs, crash reporters and terminal
 * scrollback. We embed a snippet of the provider's response body when a token
 * request fails, which is genuinely useful for diagnosis — but the body is not
 * ours and cannot be trusted to be credential-free. A misconfigured gateway
 * echoing the request back would put a live `refresh_token` straight into the
 * consumer's logs.
 *
 * This is defence in depth, not a guarantee: it recognises the OAuth parameter
 * names and the token shapes the supported providers actually issue. Never rely
 * on it to make an arbitrary secret safe to print.
 */

/** OAuth parameters whose values are credentials, in JSON or form encoding. */
const SECRET_PARAMS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'code_verifier',
  'device_code',
  'token',
  'code',
  'assertion',
]

/**
 * Matches key, optional quotes, `:` or `=`, optional quotes, then the value up
 * to a delimiter — covering `{"refresh_token":"x"}` and `refresh_token=x&…`
 * alike.
 */
const PARAM_PATTERN = new RegExp(
  String.raw`(["']?\b(?:${SECRET_PARAMS.join('|')})\b["']?\s*[:=]\s*)["']?([^"'&,}\s]{4,})["']?`,
  'gi',
)

/** Token shapes the supported providers issue, in case they appear bare. */
const TOKEN_SHAPES: { issuer: string; pattern: RegExp }[] = [
  { issuer: 'Authorization header value', pattern: /\bBearer\s+[\w.~+/=-]{8,}/gi },
  { issuer: 'Claude', pattern: /\bsk-ant-[\w-]{8,}/gi },
  { issuer: 'OpenRouter', pattern: /\bsk-or-v1-[\w-]{8,}/gi },
  { issuer: 'OpenAI', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { issuer: 'GitHub', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { issuer: 'Gemini', pattern: /\bya29\.[\w.-]{8,}/g },
  {
    issuer: 'JWT',
    pattern: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  },
]

export const REDACTED = '[redacted]'

export function redactSecrets(text: string): string {
  let out = text.replace(PARAM_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)

  for (const { pattern } of TOKEN_SHAPES) {
    out = out.replace(pattern, REDACTED)
  }

  return out
}

/**
 * Prepares an untrusted response body for inclusion in an error message:
 * redacted, collapsed onto one line, and truncated.
 */
export function safeSnippet(text: string, maxLength = 200): string {
  const collapsed = redactSecrets(text).replace(/\s+/g, ' ').trim()

  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed
}
