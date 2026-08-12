---
'@ai-oauth-sdk/core': patch
---

Bind a pending authorization to the provider that started it

Pending records are keyed by `state` alone, and one storage is routinely shared
by every client an app builds. `completeAuthorization()` consumed whatever
record that key named without ever asking whose it was, so a callback handed to
the wrong client posted the *other* flow's code, PKCE verifier and redirect URI
to this provider's token endpoint, under this provider's client id.

Mis-routing the callback is an application bug, and the exchange fails — the
receiving server does not recognise a code it never issued. But it fails after
the request goes out, so the credential has already left the process, and the
legitimate flow's record is consumed either way and can no longer complete.
That is the mix-up class of OAuth 2.0 Security BCP §4.4: the authorization
response is not bound to the issuer it came from. A hostile or low-trust
provider on the receiving end gets a live code plus its verifier plus its
redirect URI for someone else's provider, whose client id is public.

The easiest way to make the mistake is a single-page app with one shared
`/callback` route, which has to pick a client before it knows whose `state` it
is holding. `consumeLatest()` — the path for providers that never echo `state`
— was provider-scoped from the start; this is the same rule on the
`state`-keyed path, and the mismatch now throws `state_mismatch`.

The record stays consumed when the check fails: a callback that reached the
wrong client should not be replayable at the right one. Ids the provider used
to have count as its own, so a flow started before a rename — `anthropic` to
`claude`, `google` to `gemini`, `microsoft` to `azureAi` — still completes
across the upgrade that renamed it, the same allowance already made for
credentials stored under a previous key.
