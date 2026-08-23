---
'@ai-oauth-sdk/core': patch
---

Cancel an in-flight login when signing out, so it cannot write the session back
over the sign-out.

`AuthStore.logout()` awaited `client.logout()` and then cleared its own state.
Neither step stops a `login()` that is already in flight. `client.logout()`
clears the client's cached tokens and deletes the stored record, but a login
parked on its receiver still holds a live authorization attempt; when that
callback lands, `completeAuthorization` reaches `setTokens()` and writes a fresh
access *and* refresh token straight back to storage. The store's own `login()`
continuation then runs `setState({ tokens, … })` and fires `onSuccess`.

The sign-out is undone durably, not transiently. Measured against a real
authorization server with `fileStorage()`: after `logout()` resolved,
`isAuthenticated()` was `false` and the record was gone from `auth.json`;
releasing the parked callback put it back, a separate `AuthClient` over the same
file read the session back, and the resurrected access token was accepted by the
resource server. Nothing downstream heals it.

`{ revoke: true }` is the worse half, in both directions. Called while already
signed out, `revoke()` early-returns because there is nothing to read, so no
revocation is sent at all. Called while signed in, it revokes the token being
replaced, and the token that survives is written live and un-revoked. Either
way the credential left at rest is the one that was never revoked — the
opposite of what the option was asked for.

`logout()` now aborts the store's controller, which is the same mechanism
`cancel()` and a superseding `login()` already use. The abort is issued *before*
the awaited `client.logout()`, and that ordering is load-bearing — though not
for the obvious reason. A login completing entirely *inside* the revoke round
trip does not survive, because `client.logout()` deletes the stored record after
revoking and that delete wipes the write. What survives is a login whose
`setTokens` write is ordered *after* the delete, and the round trip is what buys
it that: the attempt gets past `consume()` and into the token request before the
logout enqueues its delete, so the response lands while the delete is already
executing. Aborting first denies it the head start, and since the signal is
threaded through `completeAuthorization` into `exchangeCode`, an abort arriving
any time before the token response resolves stops the write outright. A test
pins the ordering, because moving the abort after the await otherwise leaves
every existing store test passing.

Aborting costs nothing when no login is pending, and `login()` already treats an
abort as a user action rather than an error, so a cancelled sign-in surfaces no
spurious error and leaves `isLoading` false.

Reachability is ordinary rather than adversarial — there is no attacker, and the
resurrected credential is the user's own. The realistic paths are an
already-signed-in user re-authenticating (account switch, scope upgrade,
re-consent) and hitting sign out, and a programmatic `logout()` on unmount, a
route change, or a 401 handler with a login pending. The harm is a silent
sign-out failure that leaves a long-lived refresh token at rest after the user
asked for it to be gone, which is what makes it worth a patch on a shared or
kiosk machine.

**What this deliberately does not cover.** The fix is in the store, so what it
binds is a sign-out to a login on the *same store instance*. Shared through
`AuthProvider` or its equivalent in the other three bindings, that is the whole
app. Two components each constructing their own store hold their own
controllers, and one's sign-out does not reach the other's parked login —
measured, with the token landing on disk. That is already the anti-pattern
`AuthProvider`'s JSDoc warns against, but it is a limit worth naming rather than
claiming the store covers every path.

Two supported patterns still race outright:

- `client.logout()` used directly, without the store. That is first-class in the
  docs and in the shipped examples.
- `deviceLogin()`, which the store does not wrap at all, and which is the only
  supported flow for GitHub Copilot and Qwen.

Closing those needs the client itself to disown a run it no longer owns, rather
than a cancellation the store happens to hold. That is a larger change to
`client.ts` and is left for a follow-up.

One residual window remains even on the store path: `setTokens()` is reached
after `exchangeCode` has fully resolved, so a sign-out landing in the single
microtask between that resolution and the storage write still writes, and leaves
inconsistent state behind it — the token on disk, the client's cache cleared, and
the store still reporting `isAuthenticated: true`. A click handler or an unmount
callback is a macrotask and cannot land there; it was reachable only by firing
the sign-out from inside a storage adapter's own `set()`.

Also unchanged, and pre-existing rather than introduced here: a login cancelled
this way leaves its `pending:<state>` record — the PKCE verifier and redirect
URI — in storage until it expires or the next `create()` prunes it. `cancel()`
has always behaved the same way. It is not a live credential, but it is the
record `consumeLatest` resolves a stray state-less callback against on an
`echoesState: false` provider, so clearing it is worth a follow-up.
