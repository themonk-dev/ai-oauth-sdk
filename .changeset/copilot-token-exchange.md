---
'@ai-oauth-sdk/core': minor
---

Make a GitHub Copilot token usable against the Copilot API.
`createAuthenticatedFetch` sent the stored `ghu_` GitHub token, which
`api.githubcopilot.com` rejects: it wants a short-lived Copilot token obtained
by exchanging the GitHub one, and the same exchange response names the host to
send it to, which differs between individual and enterprise accounts. So neither
the credential nor the base URL could be known from the descriptor, and every
request went out with the wrong one of each.

A new optional `exchangeCredential` hook on `ProviderConfig` resolves a stored
token into the `ResolvedCredential` a request actually needs: a token, a base
URL, headers and an expiry. `createAuthenticatedFetch` calls it, caches the
result until shortly before it expires, and re-runs it on a 401 rather than
refreshing the underlying OAuth token, since the exchanged credential is the
part that goes stale. Providers without the hook are unaffected.

`exchangeForCopilotToken()` now also returns `apiBaseUrl` when GitHub names one,
and is still exported for anyone driving requests by hand.

Two smaller corrections came with it. The `headers` option on
`createAuthenticatedFetch` now takes precedence over provider-supplied headers,
so `{ 'Editor-Version': 'my-cli/1.0' }` identifies you as yourself rather than
losing to the default; a header set on the request itself still wins over both.
And that merge is now case-insensitive, the way HTTP is.
