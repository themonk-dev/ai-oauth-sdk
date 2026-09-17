---
'@ai-oauth-sdk/browser': patch
'@ai-oauth-sdk/cli': patch
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/node': patch
---

Fixes from a scheduled audit sweep. Each was found by a finder pass, put to a
reviewer whose instructions were to refute it with a running reproduction, and
implemented only once it survived; every regression test here was confirmed to
fail with its own fix reverted.

**A slow token read could erase a login or a logout** — `core`. `getTokens()`
tested `#tokensLoaded` before its await and never again after it, with no
in-flight dedupe, so a value written while a read was in flight was overwritten
by the value that read had already fetched. A login completing during the read
left `getAccessToken()` throwing "Not authenticated" for the life of the process
while the token sat in storage; a `logout()` during the read was undone and the
user signed back in. One shared load promise and an epoch bumped by every write
now make a stale read discard what it fetched.

**`setTokens` committed to memory before persisting** — `core`. A rejected write
left the caller holding a failure while the client was authenticated in memory,
and on a rotating-refresh-token provider the rotated token existed only in
memory while disk held the spent one.

**A falsy `refresh_token` destroyed the stored one** — `core`. The carry-forward
test was truthiness over the whole `??` chain, so `"refresh_token": ""` dropped
the previous token rather than carrying it forward, and the next `refresh()`
forced a re-login. `expires_in` sent as the string `"3600"` yielded no
`expiresAt` at all, and `isExpired` reads a missing one as "never expires".

**A device grant was shaped by different rules than a redirect grant** — `core`.
`parseTokenResponse` and `enrichTokens` were never called, so a custom provider's
non-standard success body was read as a failure and quoted verbatim into the
error — a live credential in the logs, and the approved grant burned. A 200 that
cannot be shaped now raises without quoting the body.

**Credential-file writes were serialised per adapter, not per file** — `node`.
`set`/`delete` are read-modify-write over the whole file, so two clients over one
`auth.json` — the ordinary one-client-per-provider shape — silently discarded
each other's records, killing a rotated session. The queue is now shared per
resolved path. Two separate *processes* sharing one credential file can still
lose a record, as before: an `O_EXCL` lock was tried and removed, because
without kernel-backed ownership it has no safe expiry — no expiry wedges the
store after a crash, and any expiry lets a slow writer's `rename` land on top of
a write that completed under a lock. That limit is now documented rather than
papered over.

**The loopback receiver could advertise what it would not serve** — `node`. An
advertised IPv6 literal that differed from the bound host was never bound, and a
`path` without a leading slash was normalised when advertised but not when
matched. Both 404'd or dropped the genuine callback, and with no default
`timeoutMs` the login waited forever. An unbracketed `::1` also produced an
unparseable redirect URI.

**A pending record was trusted on the strength of parsing** — `core`. `'null'`
is valid JSON, so the guard dereferenced it and threw a `TypeError` out of
`login()` before the offending key could be deleted, wedging every later login.
Malformed records now take the existing drop path, which also closes a TTL
bypass for records carrying no `expiresAt`.

**The paste fallback used a port this SDK publishes** — `core`. 1455 is OpenAI's
own loopback port, so a paste login for another provider handed `?code=` to
whatever held it. PKCE keeps the code unredeemable; what was lost is its
confidentiality.

**Endpoint flags silently re-aimed a remembered custom provider** — `cli`. The
guard on `--authorize-url` / `--token-url` covered built-ins only, and the flags
took precedence over the remembered descriptor without ever loading it — so
`refresh acme --token-url elsewhere` sent the stored refresh token there, exited
0 with an empty stderr, and overwrote the stored tokens with the reply. The two
descriptors are now compared, and `login` is the explicit way to move a provider
that has genuinely changed endpoints.

**`logout --revoke` reported the request, not the result** — `cli` + `core`.
`revoked` echoed the flag, so it read `true` both for the five of seven built-ins
that declare no revocation endpoint and for a revocation the provider actively
refused — the latter with no signal anywhere. `AuthClient.logout` now returns a
`LogoutResult` carrying that outcome, and the store and the four framework
bindings widen with it. The core change is additive — callers ignoring the
return value are unaffected — but note the **CLI's JSON output changes**:
`logout --revoke --json` now reports `revoked: false` for the five of seven
built-ins that declare no revocation endpoint, where it previously said `true`.
A script gating on that field was reading a constant; it will now see the truth,
which may be a different value than it saw yesterday.

**A web storage global was trusted without a document behind it** — `browser`.
The SSR guard decided "browser" from the presence of `localStorage` /
`sessionStorage`. Node ships Web Storage on by default from v26, so a server
render there got a working adapter and the refusal never fired — and Node's
`localStorage` is a file while its `sessionStorage` is process-global, so that
pools every request's PKCE verifier and tokens into one store. Same shape as the
workerd misdetection: a negative test for "not a browser" that a non-browser
runtime satisfies. The check now asks for a document positively. Deno and Bun
expose the same globals server-side.

**An explicit `storage: undefined` erased the sessionStorage default** — `browser`.
The default was spread before the caller's options, so the ordinary
`{ storage: props.storage }` idiom silently reached `memoryStorage()` — failing
redirect flows at the end of the round trip, and taking the SSR refusal guard
down with it.
