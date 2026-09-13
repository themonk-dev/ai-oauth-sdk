---
'@ai-oauth-sdk/core': patch
---

Serialise concurrent callbacks for one `state` across every client in the process, not just within one.

`SECURITY.md` says callbacks arriving together for one `state` are serialised so
that "a browser double-submit or a prefetched redirect gets one exchange rather
than two", and names the process as the boundary — the only stated gap being two
*processes* over one credential file. That wording was true only within a single
`AuthClient`. The map the gate runs on was a field of `AuthorizationRegistry`,
and `AuthClient` builds its own registry in its constructor, so two clients in
one process shared no gate at all.

That is not an exotic arrangement, it is the documented one.
`recipes/multi-user` defines `clientFor(userId)` returning a fresh
`createAuthClient({ storage: prefixedStorage(shared, …) })` and says outright
that "constructing one per request is fine", then calls
`clientFor(userId).completeAuthorization({ callbackUrl: c.req.url })` from the
callback route. Every callback request therefore built its own registry, and the
serialisation added in the previous release was inert for exactly the deployment
shape the docs recommend.

Reproduced end to end against the fake authorization server: two clients over one
`memoryStorage()`, one `state`, both callbacks in flight — two exchanges, both
fulfilled, posting the same `code` with the same `code_verifier`. Sequential
replay across two clients was already refused with `unknown_state`, so only the
concurrent path was affected, which is precisely the path the gate exists to
close.

What the duplicate costs is the reuse itself. RFC 6749 §4.1.2 lets an
authorization server that sees one code redeemed twice revoke every token it has
already issued for it, so the user's just-completed session is destroyed while
the application reports success — one of the two calls returns a `TokenSet` and
writes it to storage, leaving a credential the server has already killed. It
needs no attacker to fire: a browser resending the callback, or a link scanner
or URL unfurler prefetching the redirect, is enough. An attacker holding a
captured callback URL can fire it deliberately.

The map is now module-level, keyed by `state`. Keying it on the storage object
instead would not have helped — the recipe hands every request a new
`prefixedStorage` wrapper even though one store sits behind them all — whereas
`state` is what identifies an authorization attempt, is 32 bytes of CSPRNG
output, and cannot silently degrade, since the library throws rather than fall
back to `Math.random()`. Sharing one map across unrelated storages is safe as
well as sufficient: a joining caller never receives the winner's record, it
awaits and then re-reads *its own* storage, so the only thing a collision could
cost is a brief wait. Entries are still removed in a `finally`, so a rejected or
hung consume cannot accumulate.

The cross-process limit is unchanged and still stated: `AuthStorage` has no
compare-and-swap, so two CLI windows over one `auth.json` can still both read
the record before either deletes it. Closing that needs an atomic primitive on
the storage interface. `SECURITY.md` needed no edit — the fix makes what it
already claims true.
