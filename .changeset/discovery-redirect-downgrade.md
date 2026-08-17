---
'@ai-oauth-sdk/core': patch
---

Refuse a discovery document that was redirected down to cleartext before it was served.

`providerFromDiscovery()` checks the issuer's scheme before the request, so the document decides the provider's endpoints only if it was asked for over `https`. That constrains where the request was *sent*. It says nothing about where the document was actually *served from*: `fetch` follows redirects by default, and outside a browser there is no mixed-content bar on an `https`→`http` hop — Node's `fetch` follows one.

So an `https` issuer that redirects to `http` lands back in the case the issuer check exists to prevent. Whoever is on the network path writes the document, names `https` endpoints of their own, and those pass every later check and are carried by the descriptor for its whole life — every subsequent code exchange and refresh POSTs the authorization code, the PKCE verifier, the refresh token and the client secret to a party of their choosing.

Reaching that state does not require an attacker to do anything clever. They cannot answer the initial `https` request at all without forging TLS, so the redirect has to come from the issuer itself. The realistic way it does is a familiar misconfiguration: an identity server behind a TLS-terminating proxy that ignores `X-Forwarded-Proto` and emits an absolute `Location: http://…` when it canonicalises a host or a trailing slash. The self-healing form of that bug, where the cleartext vhost redirects straight back to `https`, is still exploitable — the attacker simply answers that one cleartext GET themselves.

The response's final URL must now use `https`, with the same loopback exemption every other check here gives, so a local authorization server on `http://127.0.0.1:<port>` keeps working.

Deliberately a scheme check and nothing more. Refusing redirects outright, or requiring the final origin to match the issuer, would break issuers that legitimately redirect for path normalisation or onto a separate identity host, and neither hop is the problem. The `http`→`https` upgrade that previously argued against checking here can no longer arise, because an `http` issuer is refused before any request is made.

The loopback exemption is inherited only when the issuer was itself on loopback. A local development server redirecting within `127.0.0.1` is ordinary; a public `https` issuer redirecting *down* onto loopback is not, and would hand the choice of endpoints to whatever local process holds that port. A final URL that does not parse is refused rather than waved through, matching what the issuer and endpoint checks already do with one.

A `FetchLike` that returns a hand-built `Response` reports its `url` as empty, so stubs and test doubles are unaffected.
