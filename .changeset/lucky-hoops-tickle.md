---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/node': patch
---

Fix `--paste` logins that stopped responding after one bad paste

With `hybridReceiver` — which is what `ai-oauth-sdk login <provider> --paste` uses for every
provider without a hosted callback page — a pasted value that could not be read as an authorization
code was discarded silently, along with the prompt that read it. Nothing was printed, no second
prompt appeared, and the next value the user typed went nowhere; because the loopback half was still
listening, the process stayed up until it was killed. One stray newline before the real paste was
enough, and so was clicking "Deny" at the provider and pasting the `?error=access_denied` URL back.

Now the prompt reports what was wrong and asks again, on the same open input, for as long as the
loopback half is still listening — and a pasted denial ends the login with `authorization_denied`,
the same result that denial produces when it reaches the loopback port instead.

`promptReceiver` gains `retryOnInvalidPaste` and `manualReceiver` gains `retry` for callers who
drive the prompt themselves. Both are opt-in and off by default, so a receiver that is the only way
a login can finish still surfaces a bad paste to its caller rather than looping on it.
