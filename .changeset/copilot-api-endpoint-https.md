---
'@ai-oauth-sdk/core': patch
---

Require `https` on the API host GitHub names in Copilot's token exchange, instead of trusting any non-empty string.

`readApiEndpoint()` accepted whatever `endpoints.api` held, provided it was a non-empty string. That value becomes `ResolvedCredential.baseUrl`, which is the base every later Copilot request is built on, and every one of those requests carries `Authorization: Bearer <copilot token>`. An `http://` value there is a cleartext downgrade of a live credential — not once, but on every request for the whole lifetime of that token, with nothing anomalous to notice.

The value is remote-supplied. It arrives in a response body, not from anything the integrator wrote, so it gets the same floor `providerFromDiscovery()` already puts under endpoints taken out of a discovery document, and for the same reason: what the integrator vouched for is GitHub's certificate, not wherever GitHub's response happens to point. It must now parse and use `https`, and what is stored is the parser's normalised `href`, so the value checked and the value used are one value. Loopback is not exempt as it is for discovery, because no part of Copilot's exchange is a local development server.

An unusable value returns `undefined` rather than throwing, which falls back to the descriptor's own `apiBaseUrl` — a working default. Failing an entire sign-in over a field there is a sound answer for would be the worse trade. Individual, business and enterprise accounts each get a different host, so the field still does its job whenever GitHub names a usable one.
