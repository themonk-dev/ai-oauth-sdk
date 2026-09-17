---
'@ai-oauth-sdk/core': patch
---

Refuse to follow a redirect on any request that carries a credential.

Every credential this library sends travels in a POST body, and none of these
requests set `redirect`, so `fetch`'s default `follow` applied. Under Node's
undici a 307 or 308 preserves the method and replays the body verbatim to the
origin the `Location` names. Measured on Node 22 against a cross-origin sink,
the redirect target received
`grant_type=refresh_token&refresh_token=…&client_secret=…&code_verifier=…` in
full. undici does strip `Authorization` and `Cookie` on a cross-origin hop, but
that mitigation buys nothing here: no bundled provider puts a credential in
`tokenRequest.headers`, so there was nothing in a header to strip. An
`https`→`http` hop is followed rather than refused, so the same body goes out in
cleartext.

A 301, 302 or 303 is rewritten to a bodiless GET and leaks nothing — but it is
still followed silently, and whatever the redirect target answers is then parsed
as the token endpoint's response. End to end before this change,
`refreshTokens()` and `exchangeCode()` resolved with a forged
`{"access_token":"pwned"}` from the target, which the client then persisted as
the user's credentials, and `revokeToken()` reported a success that revoked
nothing. The `!response.ok` check that would have caught a 3xx never sees one,
because `fetch` has already resolved it.

Five call sites were exposed: the token endpoint POST behind both
`exchangeCode()` and `refreshTokens()`, RFC 7009 revocation, the RFC 8628 device
authorization request, the device poll loop, and OpenAI's JSON device flow. The
poll loop is the sharpest of them — it carries `device_code` and `code_verifier`
and fires every few seconds for up to a quarter of an hour, so a single 308 there
exfiltrates the grant repeatedly rather than once.

All five now pass `redirect: 'error'`. `'error'` rather than `'manual'`, because
an opaque-redirect `Response` would fall through to the status check and be
reported as a generic token failure rather than as what it is. The guard is set
at each call site rather than in `fetchWithSignal`, which
`createAuthenticatedFetch()` also goes through to call arbitrary provider APIs —
path canonicalisation, regional host moves and pre-signed blob URLs all redirect
legitimately there, and defaulting it underneath would have broken those callers
at runtime. No shipped provider endpoint redirects, so nothing that worked before
stops working.

This is narrower than the neighbouring discovery guard by design: that one is a
scheme check, because an issuer may legitimately redirect for path normalisation
or onto a separate identity host. A token POST has no such case, so it is refused
outright.

Known limitation, stated rather than papered over: this is a `fetch` option, and
a runtime is free to ignore it. React Native's whatwg-fetch polyfill is XHR
underneath and follows redirects transparently whatever the option says, and a
custom `FetchLike` may ignore it too. On those the guard is a no-op and `https`
is what protects the body.
