---
'@ai-oauth-sdk/cli': patch
'@ai-oauth-sdk/core': patch
---

Strip terminal control characters from provider-supplied text before it reaches the terminal.

A good deal of what the CLI prints was chosen by the other end: an `error_description` quoted out of a token response, the verification URL and user code from a device-authorization response, the email read off an id_token. All of it reached stderr with ESC, BEL, NUL, DEL and the C1 range intact, because the only cleanup on that path was `safeSnippet`'s `/\s+/g` and JavaScript's `\s` matches none of those characters.

With ESC intact the text does not have to settle for being ugly. `\x1b[2K\x1b[1A` erases the `✗ Refresh failed` line the CLI has just written and moves back onto it, and `\x1b[32m` paints what follows green — so a hostile or compromised token endpoint can replace a visible failure with a convincing `✓ Signed in as attacker@evil.example`, or set the terminal title with an OSC sequence. Redirecting output does not help; the sequences sit in the log file and do it again to whoever reads it.

`plain()` in the CLI's output module removes C0 except tab and newline, DEL, and C1. It is applied to the untrusted interpolations — the error messages `run()` prints, the device verification URL and user code, the account name and granted scopes `whoami` shows, and the email on the `Signed in to …` line — rather than inside `info()`, because `info()` is also how the CLI emits its own ANSI colour and stripping there would erase the formatting along with the attack. `table()` strips every header and cell before it measures column widths, so an escape sequence cannot throw the columns out of alignment either.

In core, `safeSnippet` now collapses those same control characters along with whitespace, so the snippets embedded in `OAuthError` messages are one line in the sense the doc comment always claimed. This catches U+0085 NEL, a real line break that `\s` does not match. Legitimate text is untouched: German, Japanese and Russian samples, emoji, em-dashes and guillemets all come back byte-identical.

The access token itself is deliberately left exactly as received. `ai-oauth-sdk token` exists to be captured by `$(...)`, and a credential the CLI quietly rewrote would turn a visible oddity into a mystifying 401 somewhere downstream.
