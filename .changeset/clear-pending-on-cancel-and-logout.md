---
'@ai-oauth-sdk/core': patch
---

Clear the pending authorization when a login is abandoned, and when the user signs out.

`login()`'s `finally` called `started.close()` and nothing else, `AuthStore.cancel()` only aborts the controller, and `logout()` deleted the `tokens:` key alone. So a login the user walked away from — ctrl-C, a closed browser, a timeout, a callback refused as forged — left its `pending:<state>` record, holding the PKCE verifier and the redirect URI, and the `pending-latest:<provider>` pointer to it, sitting in storage until the TTL expired them ten minutes later. Signing out in the middle of a login left both behind too.

This is sign-out hygiene rather than a vulnerability, and it is worth being precise about why. On a provider that never echoes `state` — `openrouter` is the only bundled one — the surviving pointer is what a later state-less callback resolves against, so a `?code=` supplied by someone else would be picked up by `consumeLatest` and exchanged. The chain reproduces, but the exchange still sends the *victim's* `code_verifier`, so any authorization server following RFC 7636 rejects it and nothing is stored. What is actually left is the part worth fixing on its own terms: material for a flow the user abandoned should not outlive the abandoning.

`login()` now deletes the record it created whenever the flow ended without tokens. On success the exchange has already consumed it, so the cleanup is a no-op there, and it cannot throw a storage error over the top of the result the caller was about to get. `logout()` additionally drops `pending-latest:` for its provider and the record that pointer names, via a new `AuthorizationRegistry.deleteLatest()` — the pointer is the only handle onto a flow whose `state` the caller signing out does not have.

Two limits on `logout()`'s half, both deliberate. It is best-effort: a storage fault on the pending pointer is swallowed, because the method promises local state is cleared either way and the token key has already gone by then. And it is scoped to the provider, not the account — `pending-latest:` has always been `pending-latest:<provider>` and `consumeLatest` is account-blind by construction, so signing out of one account now clears an in-flight login for another account of the same provider, which fails `unknown_state` and has to be restarted. That is the trade being made: a login the user can retry, against a redeemable pending record outliving an explicit sign-out.
