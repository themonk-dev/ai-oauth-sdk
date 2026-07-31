---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/cli': patch
---

Report token failures accurately, and never quote a credential doing it.

**`state` broke every OpenAI login.** It was added to the token request because
Anthropic accepts it there, but it was sent to every provider — and `state`
belongs to the authorization request, not the exchange. OpenAI rejects the whole
call with `Unknown parameter: 'state'`, which failed both the loopback and the
paste flow, so `login openai` could not complete at all. It is now opt-in via
`tokenRequest.includeState`, which only Anthropic sets.

**Token errors are readable again.** RFC 6749 says `error` is a string. OpenAI
answers with an object — `{"error":{"message":…,"type":…}}` — which the message
interpolated straight into the string:

```
token_request_failed: Token request to … failed (HTTP 400): [object Object]
```

Nested shapes are unwrapped, and anything unrecognised falls back to a snippet
of the body. The device path had the identical bug and the identical fix.

**Every quoted response is redacted first.** `readTokenError` returned `detail`
and nested `message` verbatim, bypassing the scrubbing that quoted provider text
is supposed to pass through — a gateway reflecting the request would have put a
live `refresh_token` into an error message and any log capturing it. The device
flow's `error_description` had the same hole.

**A dead gateway fails in seconds, not fifteen minutes.** Device polling
tolerates a 5xx because it is the provider's infrastructure talking, not a
verdict on the grant. But a proxy that is simply *down* answers every poll, and
retrying to the device code's expiry blocked for the full code lifetime and then
reported `timeout: Device code expired before the user approved it` — telling
the user they were too slow to approve when the truth was a 502. Three
consecutive server errors are tolerated, then the real status is reported.

**`createAuthenticatedFetch` sends the token it manages.** It used to let an
`Authorization` header already on the request win. That is reasonable when you
call it directly, and wrong when the caller is an SDK that sets `Authorization`
from its own `apiKey` before handing over — the single most likely way this
function gets used. The Vercel AI SDK does exactly that, and sends the header
even when `apiKey` is empty or omitted, so the obvious wiring shipped
`Bearer unused` while the library refreshed the real token and attached it to
nothing. Verified against `ai` + `@ai-sdk/openai`. Pass
`respectCallerAuthorization: true` to restore the old behaviour.
