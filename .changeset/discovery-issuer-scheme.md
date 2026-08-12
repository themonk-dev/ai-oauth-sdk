---
'@ai-oauth-sdk/core': patch
---

Require `https` on the issuer `providerFromDiscovery()` fetches from, except on loopback.

The previous release required `https` on the endpoints lifted *out of* a discovery document. It never checked the URL the document was fetched *from*: the issuer was string-concatenated into a `.well-known/openid-configuration` path and handed to `fetch`, so `providerFromDiscovery('http://sso.corp.internal', …)` was accepted without comment.

That leaves the strictly worse half of the same problem open. The library would reject an `http` `token_endpoint` served by an `https` issuer — a misconfiguration, visible to whoever runs the issuer — while accepting an `https` `token_endpoint` chosen by whoever sits on the network path in front of an `http` issuer. An on-path attacker answering the cleartext discovery request returns a document naming `https://evil.example/authorize` and `https://evil.example/token`; both are `https`, so the endpoint check passes them, and passing is worse than silence here because it reads as validation of values the issuer never sent. The descriptor then carries them for its entire life, and every `exchangeCode()` and `refreshTokens()` POSTs the authorization code, the PKCE `code_verifier` and any `clientSecret` to the attacker.

The rationale for the endpoint check already rested on this: "an `https` issuer — TLS-verified, and the only thing the integrator actually vouched for". The code simply never enforced the assumption it was reasoning from. It does now, using the same rule and the same `127.0.0.1` / `[::1]` / `localhost` exemption, so local development authorization servers keep working. An issuer that does not parse as a URL is rejected too, with its own message. The check runs before the request rather than after it, because a cleartext discovery request has already announced the client and invited a response by the time any value could be examined.

An integrator who genuinely has a plaintext internal IDP should describe it with `defineProvider()`, which leaves a hand-written `http` endpoint alone as it always has. Note that passing `authorizationUrl` and `tokenUrl` explicitly is no longer a way to keep a cleartext *issuer*: the check runs before the fetch, and it has to, because the discovery request itself is the part that travels in the clear. Endpoints an integrator typed are still exempt from the endpoint check — that exemption is unchanged — but they no longer excuse the transport.

Nothing was added around redirects. Refusing them, or comparing the final `response.url` origin to the issuer, breaks issuers that legitimately redirect — an `http`→`https` upgrade, or path normalisation — and a custom `fetchImpl` is free to ignore either signal anyway. Validating the document's own `issuer` claim likewise stays out: with the issuer required to be `https`, that is spec conformance rather than a vulnerability, and it would reject multi-tenant deployments by design.
