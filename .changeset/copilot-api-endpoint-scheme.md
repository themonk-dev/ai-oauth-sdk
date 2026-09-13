---
'@ai-oauth-sdk/core': patch
---

Require `https` on the API host GitHub names in the Copilot token exchange, except on loopback.

`exchangeForCopilotToken()` read `endpoints.api` out of the exchange response and returned it as a plain string with no examination. It becomes `ResolvedCredential.baseUrl`, and every later relative-path request through `createAuthenticatedFetch()` is resolved against it carrying the Copilot bearer token — so one unexamined remotely-supplied string decided, for the life of that credential, who received it. A response naming an `http://` host would have sent it over cleartext, with nothing anomalous for the caller to notice.

This is defence in depth, not a live hole, and it is worth saying so plainly: the document arrives over TLS from a hard-coded `https://api.github.com`, so writing an `http://` host into it means having already broken that connection. What argues for the check anyway is consistency. `providerFromDiscovery()` treats a remotely-supplied endpoint as hostile and refuses one that is not `https`, not loopback, or not parseable at all, for reasons that apply word for word to this value — it is the same kind of string, arriving the same way, and deciding the same thing.

The value must now parse as a URL and use `https`, with `http` allowed on `127.0.0.1`, `[::1]` and `localhost` so a local proxy or a recording fixture still works. Anything else is treated exactly as an absent `endpoints.api` already was, leaving the descriptor's own `apiBaseUrl` in place.

It returns rather than throws, which is the one place it diverges from the discovery check deliberately. That check runs at construction time, where refusing costs nobody a session; this one runs in the middle of a live sign-in, and a defence-in-depth check is not worth breaking a login over.

The host is not pinned to `api.githubcopilot.com` or to any `github.com` suffix. Enterprise accounts genuinely get a different host — that is the whole reason the field is read from the response rather than configured — so anything narrower than a scheme check would refuse legitimate deployments.
