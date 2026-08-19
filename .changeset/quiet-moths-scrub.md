---
'@ai-oauth-sdk/core': patch
---

Redact OAuth credential parameters in a response body that was escaped on its
way back.

`redactSecrets` matched `refresh_token` followed by an optional quote, optional
whitespace, then `:` or `=`. A gateway that echoes our request rarely hands it
back as it received it: wrapping the body into a JSON envelope escapes the
quotes in it, so the parameter name is followed by `\":\"`, the optional quote
matched empty, and `[:=]` then failed on the backslash. The whole match failed,
and a failed match prints the value.

Only the raw-body fallbacks are affected, and that is where it bites. When the
provider answers with `error_description`, `detail` or a nested `error.message`,
`JSON.parse` has already unescaped the string by the time redaction sees it, so
those paths were correct throughout. A plain, valid, error-less JSON envelope —
`{"upstream_status":502,"upstream_body":"…"}`, which is what a proxy reporting
an upstream failure produces — matches none of the fields `readTokenError`
knows, falls back to a snippet of the body still escaped as it arrived, and put
a live `refresh_token` into `OAuthError.message` and from there into logs. A
token with no vendor prefix has no shape for `TOKEN_SHAPES` to catch on the way
past either. `openrouter` posts `style: 'json'` and carries `code` and
`code_verifier`, so the escaped form is reachable with a bundled provider.

The quoting either side of the separator is now a bounded `[\\"']{0,4}`, which
covers two levels of escaping. `SECURITY.md` says the redaction scrubs the named
OAuth parameters, so this was a gap in stated behaviour rather than one of its
acknowledged limits; the limits themselves are unchanged.

Two things the fix deliberately does not do, both now noted in the code. The
backslash stays inside the value character class and the trailing quote is still
consumed: excluding `\\` to make the escaped form match would fail the whole
match on a value that merely contains a backslash, which is a new leak in place
of the old one, and dropping the trailing quote leaves a stray one behind in the
snippet. And the bound stays a bound — generalising it to `(?:\\*["'])?`
backtracks quadratically over a run of backslashes in an attacker-controlled
body, 69 seconds for 400k of them against 7 milliseconds here.
