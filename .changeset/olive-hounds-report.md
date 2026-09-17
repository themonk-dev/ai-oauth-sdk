---
'@ai-oauth-sdk/browser': patch
'@ai-oauth-sdk/core': patch
---

Stop two security controls from reporting success while doing nothing.

`azureAi()` declared `revocationUrl` as `${base}/logout`. That is Entra's OIDC
`end_session_endpoint` — a front-channel URL the browser is navigated to in
order to clear a sign-in session — not an RFC 7009 revocation endpoint. Entra
publishes no such endpoint at all; its discovery document has no
`revocation_endpoint` field.

Declaring it was worse than declaring nothing. `revokeToken` POSTs the refresh
token to whatever the field holds and, per RFC 7009, treats HTTP 400 as success
alongside 2xx, since an unknown or already-revoked token is terminal rather than
retryable — so both answers a sign-out page can give read as "revoked".
`logout({ revoke: true })` swallows what is left so a failed revocation cannot
leave a user apparently signed in, and the CLI only warns "clearing locally
only" when the field is absent. The result was that `logout --revoke azure-ai`
reported a revocation that had not happened, on the one bundled provider where
it had not, at the moment a user reaches for it: after a credential has leaked.
The refresh token stayed live, and the mitigation the user believed they had
applied was the one available to them. With the field gone, `revoke()` refuses
with `configuration_error` and the CLI says what it actually did; ending an
Entra session is a directory operation (Graph's `revokeSignInSessions`), and the
docs now say so.

`localStorageAdapter()` and `sessionStorageAdapter()` told a Web Worker apart
from a server render with `'WorkerGlobalScope' in globalThis`. Cloudflare's
workerd satisfies that: it declares `WorkerGlobalScope` as a global class and
puts it on the Worker global object too. Workers is a documented target, and it
is a server — one isolate serves every request in a deployment, and
`memoryStorage()` there is a `Map` scoped to the module, not the request. So the
probe handed back an in-memory store for exactly the case `unavailableStorage`
exists to refuse, pooling one user's access token, refresh token and PKCE
verifier into a Map the next user's request reads from. `globalThis instanceof
WorkerGlobalScope` does not separate them either, since workerd's global really
is one. The test is now positive evidence of a browser worker — `WorkerGlobalScope`
and `WorkerNavigator`, the latter `[Exposed=Worker]` and absent from workerd,
Node, Deno and Bun — so an unrecognised runtime gets the refusal rather than a
silent shared store.
