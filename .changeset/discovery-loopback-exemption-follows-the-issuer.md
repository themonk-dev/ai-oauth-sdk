---
'@ai-oauth-sdk/core': patch
---

A discovery document's endpoints only inherit the loopback exemption when the issuer is itself on loopback.

The exemption exists so that cleartext which never reaches a wire is not held to TLS: a local development authorization server on `http://127.0.0.1:<port>` describing its own endpoints is the ordinary case. It was applied to the document's endpoints unconditionally, which is a different thing. A remote `https` issuer naming `http://127.0.0.1:8123/token` was accepted, and the descriptor then carried that endpoint for its whole life, so every code exchange and refresh posted the authorization code, the PKCE verifier, the refresh token and the client secret to whatever local process held the port — with a TLS-verified issuer standing behind the descriptor as though the value had been validated.

`assertSecureDiscoveryResponse` already draws the line in the right place for the redirect target, and its comment says why: a public issuer arriving on loopback "hands the choice of endpoints to whatever local process holds that port". The endpoint check now asks the same question. Being remote and TLS-verified does not entitle a party to pick which process on the reader's machine receives their credentials.

Nothing changes for a loopback issuer: its document's `http://127.0.0.1`, `http://localhost` and `http://[::1]` endpoints are accepted exactly as before. Endpoints you pass explicitly as `authorizationUrl` or `tokenUrl` are still your own config and are still left alone. The refusal message no longer claims a loopback exemption in the case where there is not one.
