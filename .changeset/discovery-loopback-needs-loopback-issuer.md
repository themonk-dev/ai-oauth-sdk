---
'@ai-oauth-sdk/core': patch
'ai-oauth-sdk': patch
---

A public `https` issuer may no longer name `http` loopback endpoints

The endpoint check gave `http://127.0.0.1:<port>` the loopback pass
unconditionally, while the redirect check four functions away grants it only
when the issuer was itself on loopback — and says why: a public issuer
redirecting down onto loopback hands the choice of endpoints to whatever local
process holds that port. The endpoint check now asks the same question.

A local development server naming its own endpoints is ordinary and keeps
working. A public issuer naming one is the downgrade the redirect check already
refuses, and it aims the authorization request, and the POST carrying the code,
the PKCE verifier and the client secret, at a port anything on the box can
claim. An explicitly passed `authorizationUrl` or `tokenUrl` is still left
alone.
