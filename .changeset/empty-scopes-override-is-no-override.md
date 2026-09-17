---
'@ai-oauth-sdk/core': patch
'ai-oauth-sdk': patch
---

`scopes: []` no longer drops the descriptor's scopes

The spread in `resolveProvider()` had already copied the empty array over the
base scopes, which left the `if (overrides.scopes?.length)` below it unable to
do anything — dead code, and itself the evidence that an empty override was
meant to be a no-op.

`createAuthClient({ provider: 'claude', clientId, scopes: [] })` therefore
emitted an authorize URL with no `scope` parameter at all, leaving the
authorization server to apply whatever default it likes, with nothing in the
URL to say the requested scopes had been dropped on the way. It is the shape
`scopes: config.scopes ?? []` produces. An empty override is now the absence of
one. A base descriptor that declares no scopes — OpenRouter — still emits none.
