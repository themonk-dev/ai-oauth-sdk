---
'@ai-oauth-sdk/core': patch
---

Serialise `AuthorizationRegistry.consume()` per state, so concurrent callers cannot all be handed the same PKCE verifier.

`consume()` read the pending record and then deleted it, with two awaits into storage in between and nothing holding the interval. Callers arriving together therefore all completed their read before any of them reached the delete, and all of them were handed the same record — the same authorization `state` and the same `codeVerifier`. Three concurrent `consume()` calls for one state all resolved, against memory storage and against the file storage the CLI uses; two concurrent `completeAuthorization()` calls both reached the token endpoint with byte-identical bodies. Replaying a state *sequentially* was refused correctly the whole time, which is precisely what made the concurrent case easy to miss.

The consequence is narrower than a replayed exchange. The verifier never leaves the process, and only one redemption of an authorization code can succeed at the authorization server, so no extra token is minted. What the duplicate buys is the code reuse itself: an authorization server following RFC 6749 §4.1.2 revokes every token it has already issued for a code it sees a second time, so the request that lost the race takes down the session the request that won had just established. It does not take an attacker holding a captured callback to get there — a browser resending a callback on a double submit, or a link scanner prefetching the redirect URI, is enough.

Calls for one state now queue: a later arrival waits for the one in flight to finish, however it finishes, and then reads again, finding the record gone and reporting it as already used. `consumeLatest()` resolves its pointer and delegates through `consume()`, so it inherits the same guarantee. Expiry, the `state_expired` branch, and the sequential single-use behaviour are unchanged, and there is no public API change.

This covers in-process concurrency only, and deliberately stops there. `AuthStorage` exposes `get`, `set` and `delete` with no compare-and-swap, so two CLI windows sharing one `auth.json` can still both read the record before either deletes it. Closing that would mean adding an atomic primitive to the storage interface and implementing it in every backend, from a file to `SecureStore` — a much larger change than this defect justifies.
