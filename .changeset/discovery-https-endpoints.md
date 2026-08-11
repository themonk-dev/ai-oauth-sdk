---
'@ai-oauth-sdk/core': patch
---

Require `https` on endpoints `providerFromDiscovery()` takes out of a discovery document, except on loopback.

`authorization_endpoint`, `token_endpoint` and `device_authorization_endpoint` were lifted from the document and handed to `defineProvider()` unexamined. That is a different trust question from the one `defineProvider()` answers. An `http` URL written into a provider descriptor by hand is something the integrator typed and chose to live with; the same string arriving in a discovery document comes from a remote party, and the only thing the integrator actually vouched for is the issuer's TLS certificate.

So an `https` issuer naming an `http` `token_endpoint` would have us POST refresh tokens and the client secret in cleartext, for the entire life of the descriptor, with nothing anomalous to notice. The `authorization_endpoint` is also the only remotely-supplied string that reaches the platform browser launcher.

Endpoints taken from the document must now parse as a URL and use `https`, with `http` allowed on `127.0.0.1`, `[::1]` and `localhost` so local development and test servers keep working. The error names the field and the offending value, because the failure surfaces at construction time, far from whoever serves the discovery endpoint.

An `authorizationUrl` or `tokenUrl` you pass in yourself is untouched — the check is on where the value came from, not on the value that wins.

No issuer-equality check was added. Binding `document.issuer` to the requested issuer defends against OAuth mix-up, which needs a client that chooses dynamically among several issuers; an `AuthClient` here is bound to exactly one provider at construction. It would also reject legitimate multi-tenant deployments, where discovery at `.../common/v2.0` returns a tenant-specific issuer by design.
