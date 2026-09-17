---
'@ai-oauth-sdk/core': patch
---

Stop a refresh that was already on the wire from putting a session back after `logout()`.

`logout()` cleared the cache, deleted the stored record and returned. A token request dispatched a moment earlier — by a background `getAccessToken()` waking inside the 60s expiry skew, which is the ordinary way a refresh starts — was still out there, and when it landed it called `setTokens()` and wrote a fresh access *and* refresh token straight back to storage. `isAuthenticated()` returned to `true`, nothing later in the session healed it, and a new process over the same `fileStorage()` read the resurrected credential as an ordinary sign-in. Subscribers of `AuthStore` saw `[true, false, true]`. The window is exactly one round trip, 100–500ms, and it is the only one: `logout()`'s synchronous prologue already cleared the cache, so a refresh that had not yet read it failed on its own.

With `{ revoke: true }` it is worse than a stale record. The revocation went to the refresh token the response was in the act of replacing, and RFC 7009 §2.1 makes cascading from one token of a pair to the other a SHOULD — so on a provider that rotates without cascading, the token left on disk is also still live at the provider. A provider that does cascade takes the new token down with the old one, which half-heals it.

A refresh is now bound to the sign-out generation it started in. `logout()` bumps that generation alongside clearing the cache, and a run that comes back to a different one writes nothing and rejects with an `aborted` `OAuthError` rather than handing back a credential the client has disowned. `logout()` also drops the shared refresh promise, so a `getAccessToken()` or `refresh()` issued after the sign-out starts fresh instead of joining a run whose result is now unusable. `AuthStore.refresh()` reads `aborted` the way it already reads a cancelled login — no error surfaced, since the user is the one who signed out.

Everything else about refreshing is unchanged: concurrent callers still share one refresh, a token another process already refreshed is still adopted without a network call, and `logout()` still does not wait for the refresh, still clears local state whether or not a revocation succeeded, and still cannot throw on its own account.

This is per client and per process. Another process refreshing the same stored credential has its own sign-out state, and `AuthStorage` has no compare-and-swap to coordinate the two — the same boundary that `consume()` and the adopt-a-stored-token path already stop at.
