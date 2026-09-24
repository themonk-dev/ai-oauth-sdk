---
'@ai-oauth-sdk/core': patch
---

Stop a superseded `login()` from writing over the state of the login that replaced it.

`AuthStore.login()` aborts the attempt in flight before starting a new one, and then sets `isLoading: true` for the new one. But the aborted attempt is still a promise that has to land somewhere, and it lands afterwards. Its landing was unguarded: both the abort branch and the error branch of the `catch` wrote store state for whichever attempt happened to be current, and the success path did the same. Only the `finally` asked whose attempt it was, with `abortController === controller`. That asymmetry is the whole bug — the identity test was already written, one line below the code that needed it.

Three things followed, all reachable from a double-tap on a sign-in button:

A superseded attempt's abort ran `setState({ isLoading: false })`, which turned off the *replacement's* spinner while the replacement was still in flight. The UI showed an idle, signed-out screen with a live login behind it.

A superseded attempt that got far enough to succeed anyway — past the abort race, in its token exchange — wrote its now-stale `TokenSet` over the newer one and called `onSuccess` a second time. The store then disagreed with the client about which credential the session held.

And a superseded attempt that failed with something other than an abort — a refused token exchange, an `authorization_denied` from the flow the user walked away from — wrote its error into the live attempt's `error` and called `onError`, while that attempt was still running. This is the most reachable of the three: it needs no race at all, only a first attempt that fails slowly.

The success and catch paths now make the same identity check the `finally` makes, so only the current attempt may write state or fire callbacks. A superseded attempt still returns to its own caller, and says nothing to anyone else. Every UI binding in this repo — React, Vue, Svelte, Solid — is a thin adapter over this store, so all four get the fix without changing.
