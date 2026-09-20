---
'@ai-oauth-sdk/core': patch
---

Stop a superseded login writing over the state of the login that replaced it.

A second `login()` supersedes the first rather than racing it, and the store already knew not to
let a discarded attempt clear the abort controller out from under the live one. Its error handling
did not get the same treatment, and a discarded login rejects *after* the new one has published
`isLoading: true` — so the old attempt's `isLoading: false` landed in the middle of a live sign-in.
A UI drawing its button on `!isLoading && !isAuthenticated`, which is what the React, Vue, Svelte
and Solid bindings make natural, put "Sign in" back in front of the user while the real login was
still running.

The worse shape of it: when the discarded attempt failed for a real reason instead of by abort —
the user clicking Deny in the popup that was about to be superseded — it also wrote that failure
into `error` and called `onError` on behalf of a login nobody was waiting on. State updates merge,
and the success path did not clear `error`, so the store could settle as authenticated with a dead
login's error still showing. The store documents the opposite.

A login that is no longer the current one now returns without touching the state or calling
`onError`, and a successful login clears `error` explicitly. Cancellation, a genuine failure of the
live login, and `onError` for it all behave as before.
