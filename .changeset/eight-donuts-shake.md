---
'@ai-oauth-sdk/core': patch
---

Delete credentials stored under a previous provider id on logout.

`logout()` deleted one key — the current id's — while the read path also looks
under every entry in `previousIds`. Signing out of a renamed provider therefore
deleted a key that had never been written, reported success, and left the live
refresh token on disk. The next client over that storage found it, migrated it
to the current key, and `isAuthenticated()` was true again: a sign-out that
survives nothing but the process it ran in.

`claude` (renamed from `anthropic`) is the one that fails outright. It has no
`revocationUrl`, so even `{ revoke: true }` takes the branch that never reads
tokens, and the read is what would otherwise have moved the old key away as a
side effect. `gemini` (`google`) and `azureAi` (`microsoft`) are exposed the
same way whenever logout runs before anything has read a token.

Deletion now covers the same keys the read covers, account suffix included, and
each old key is cleared independently so one storage backend that objects to a
key it does not hold cannot strand the rest.
