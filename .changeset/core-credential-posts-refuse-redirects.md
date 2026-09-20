---
'@ai-oauth-sdk/core': patch
---

Refuse to follow a redirect away from the token, revocation and device endpoints.

Every POST that carries a credential — the code exchange, a refresh, RFC 7009 revocation, both
device flows — was sent with `fetch`'s default `redirect: 'follow'`. A 307 or 308 preserves the
method *and* the body when it is followed, so a token endpoint answering
`Location: http://attacker.example/token` had undici replay the whole request there: the
`refresh_token`, the `code_verifier` and the `client_secret`, in cleartext if the hop landed on
`http`. The reply then came back and was parsed as the token response, so the same hop also chose
the access token the caller went on to use. Discovery has been guarded against exactly this since
it started checking where its document was served from; the request beside it that actually carries
the secrets was not.

These requests are now sent with `redirect: 'manual'` and a redirected response is rejected rather
than followed — an `OAuthError` naming the provider and the endpoint, so it reads as what it is
instead of as the network being down. `createAuthenticatedFetch` is deliberately untouched: those
are your own API calls, where a redirect is ordinary traffic and following one is correct.

No shipped provider's token endpoint redirects, so this changes nothing about a working sign-in. If
you point the SDK at your own gateway and it answers a token request with a 301 or 302 — a
canonicalising proxy adding or removing a trailing slash is the usual cause — that request now
fails instead of quietly succeeding at the redirect target. Configure the endpoint's final URL.

One limitation worth knowing: React Native's `fetch` is XHR-backed and ignores `redirect` entirely,
so it keeps following and this cannot catch it there. Nothing breaks on React Native; nothing is
enforced either.
