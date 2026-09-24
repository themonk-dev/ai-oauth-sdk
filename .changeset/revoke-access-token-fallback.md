---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/cli': patch
---

Revoke the access token when there is no refresh token, instead of revoking nothing.

`revokeToken()` defaulted to `refresh_token` and read the token straight out of `tokens.refreshToken`, so a session that has no refresh token — a grant issued without `offline_access`, a provider that simply does not hand one out, a set whose refresh token was dropped on a renewal — threw `configuration_error` before the request was ever built. On its own that would be loud. It was not loud, because `logout({ revoke: true })` catches everything a revocation throws and clears local storage regardless, which is the right rule for a network failure and the wrong outcome for this one: `logout({ revoke: true })` on such a session made zero requests, resolved cleanly, wiped the credential from the device, and left a live bearer token live at the provider for the rest of its lifetime. Nobody was told. The user's belief that they had signed out everywhere was formed entirely by the absence of an error.

Where there is no refresh token the access token is now revoked instead. RFC 7009 §2.1 lets a client revoke either type and makes `token_type_hint` optional, so this is a request the provider is obliged to understand. It is the weaker of the two and the release is not claiming otherwise: it ends this credential and not necessarily the grant behind it, and where the provider still considers the session live, anything else holding a refresh token can carry on. But a bounded revocation is the whole of what such a token set can ask for, and it is the difference between one credential being dead and none being dead.

The preference never runs the other way. A set holding both still revokes the refresh token — that is what actually ends a session, providers cascade downward rather than upward, and an explicit `tokenType` is still honoured exactly as passed. `configuration_error` is now thrown only when there is nothing revocable at all.

`logout({ revoke: true })` keeps swallowing a failed revocation, deliberately: a provider that cannot be reached must not leave the user apparently still signed in.

The CLI stopped short of that swallow in the wrong place. `logout --revoke --json` printed `revoked: true` whenever the `--revoke` flag was present, which is the flag being echoed back rather than anything that was observed — it read the same for a revocation the provider confirmed, one it refused, one that never left the machine, and one the provider had no endpoint for. A script gating "the credential is dead at the provider" on that field was reading a value that could not fail. `logout` now runs the revocation itself, in the open, before clearing locally, and `revoked` reports what happened: `true` only for a call that returned successfully, `false` otherwise, with a warning on stderr naming the reason. The field stays a boolean, the human-readable line says which of the two it was, and the clear-locally-regardless rule is untouched — every path still reaches `client.logout()`.
