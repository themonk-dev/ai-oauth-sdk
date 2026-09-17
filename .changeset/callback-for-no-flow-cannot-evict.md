---
'@ai-oauth-sdk/core': patch
'ai-oauth-sdk': patch
---

A callback for a flow the client never started no longer reaches the result buffer

`completeAuthorization()` rejected on whatever `state` the request carried — on
the `error=` branch with no lookup at all, and on the `code=` branch through the
`catch` after `consume()` threw `unknown_state`. Buffered results are a
fixed-size FIFO over every state at once, evicting the oldest at `maxSettled`
(1000), so about a thousand unauthenticated requests to a public `/callback`
pushed out every genuine buffered `TokenSet`. Those logins had already
succeeded; their `waitFor()` then sat until it timed out. The caller needs no
code, no secret and no valid `state`, only the URL.

Both paths now write to the registry only for a `state` with a pending record
this client owns, which is the ownership rule `completeAuthorization()` already
applied before exchanging a code. A denial on a flow the client did start still
reaches its waiters, and so does an expiry: `state_expired` is thrown after the
record has been deleted, so it is recognised on its own rather than through the
flag the exchange path sets.
