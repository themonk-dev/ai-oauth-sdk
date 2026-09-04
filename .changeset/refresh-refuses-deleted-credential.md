---
'@ai-oauth-sdk/core': patch
---

Refuse to refresh a credential another process has signed out of.

`refresh()` re-reads storage before refreshing, so that a client whose cached token has been overtaken by another window adopts what is there rather than racing it. It only ever acted on a record it *found*: where the read came back with nothing, the branch was skipped, the refresh went ahead on the refresh token still in memory, and `setTokens()` wrote the result back — recreating the credential file, with a new access token and a new refresh token, moments after `logout()` deleted it. Every process reading that store afterwards, including a fresh one, saw an authenticated session the user had ended.

Nothing exotic is needed to reach it. Two CLI windows over one credential file is the ordinary arrangement, `logout` in one and any call that renews a token in the other is the ordinary sequence, and the window is as long as the second process keeps running.

An empty read is now read for what it is. Tokens in memory can only have come from reading the record or from `setTokens()`, which writes before it returns, so a client holding tokens and finding nothing stored is looking at a deletion rather than an absence: the record demonstrably existed. That case drops the cached copy and throws `refresh_failed` naming the provider, instead of refreshing and writing.

A record that is present but will not parse is deliberately not treated the same way. That is a damaged file, not a decision anyone took, and it still self-heals the way it always has — refresh over it and rewrite it — because failing closed there would turn a truncated write into a forced re-login. Telling the two apart is the whole of the change; a `logout()` on the same client is unaffected, since it clears the cache as well as the record and there is nothing left in memory to protect.

What this does not do is reach a token that has already left. An access token `getAccessToken()` returned before the sign-out stays valid until the provider says otherwise, which is what `logout({ revoke: true })` is for.
