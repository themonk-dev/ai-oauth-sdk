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
 * Matches key, optional quoting, `:` or `=`, optional quoting, then the value
 * up to a delimiter — covering `{"refresh_token":"x"}` and `refresh_token=x&…`
 * alike.
 *
 * The quoting is `[\\"']{0,4}` rather than `["']?` because a gateway echoing
 * our request rarely hands it back as it received it. Wrapping the body into a
 * JSON envelope escapes the quotes in it, so the key is followed by `\":\"`
 * and the old `["']?` — which matched empty, leaving `\s*[:=]` to fail on the
 * backslash — matched nothing at all. Four characters covers two levels of
 * escaping, which is as deep as anything real nests.
 *
 * Two details are load-bearing and easy to "improve" into a defect:
 *
 * - The backslash stays *inside* the value class, and the trailing `["']?`
 *   stays. Excluding `\\` from the value would fail the `{4,}` quantifier —
 *   and so the whole match — on a value that merely contains a backslash,
 *   printing the credential; dropping the trailing quote would leave a stray
 *   one behind and corrupt the snippet a human reads.
 * - `{0,4}` must not become `*`, and must not be generalised to
 *   `(?:\\*["'])?`. The response body is attacker-controlled, and that
 *   generalisation backtracks quadratically over a run of backslashes: 1.0s,
 *   4.2s, 17.3s and 69.1s for 50k, 100k, 200k and 400k of them. A bounded
 *   class is O(1) per start position.
 */
const PARAM_PATTERN = new RegExp(
  String.raw`(\b(?:${SECRET_PARAMS.join('|')})\b[\\"']{0,4}\s*[:=]\s*)[\\"']{0,4}([^"'&,}\s]{4,})["']?`,
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
