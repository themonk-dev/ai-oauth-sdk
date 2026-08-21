---
'@ai-oauth-sdk/react': patch
---

Reset `useAuth` state in the same render that rebuilds the store, so a provider
or account swap never renders the previous session's tokens.

`useAuth` rebuilds its store when the provider, client id, redirect URI, scopes
or account key change, but the state it returned lived in a separate `useState`
that only the subscription in the mount effect ever wrote. The render that first
returned the *new* store therefore still returned the *old* store's `tokens`, and
that render committed: for one frame, `client` described the provider you had
just switched to while `tokens.accessToken` was still the one you had switched
away from. The new store's empty state only arrived a frame later.

The visible consequence is a stale frame rather than a request to the wrong
place. Consumers that read the token through `getAccessToken()` or
`createAuthenticatedFetch(client)` were never affected — those take the
credential from the client's own storage, so they always used the right one; the
worst they saw was one redundant request from an `isAuthenticated` that was
briefly stale-true. What the hook did guarantee to produce was a committed frame
pairing the new provider's identity with the previous provider's bearer token,
which matters if you render `tokens.accessToken` or hand it to something keyed
off the provider, and switch provider in place without remounting the component.

State and the store it came from are now held as one value, so the swap is
atomic: the render that returns the new store returns the new store's state,
which is `undefined` tokens until it restores. Nothing about store identity
changed, and mid-flight logins are still cancelled — not destroyed — when the
effect tears down, so a `StrictMode` remount still resyncs.
