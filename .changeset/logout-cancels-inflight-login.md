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
the awaited `client.logout()`, and the ordering is load-bearing: with
`{ revoke: true }` that call makes a network round trip, so aborting after it
would leave a full round trip in which the parked login can complete and write.
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

**What this deliberately does not cover.** The fix is in the store, so it covers
all four UI bindings — React, Vue, Svelte and Solid all delegate `logout`
straight to it — and nothing else. Two supported patterns still race:

- `client.logout()` used directly, without the store. That is first-class in the
  docs and in the shipped examples.
- `deviceLogin()`, which the store does not wrap at all, and which is the only
  supported flow for GitHub Copilot and Qwen.

Closing those needs the client itself to disown a run it no longer owns, rather
than a cancellation the store happens to hold. That is a larger change to
`client.ts` and is left for a follow-up.

One residual window remains even on the store path: `setTokens()` is reached
after `exchangeCode` has fully resolved, so a sign-out landing in the single
microtask between that resolution and the storage write still writes. A click
handler or an unmount callback is a macrotask and cannot land there; it was
reachable only by firing the sign-out from inside a storage adapter's own
`set()`.
