---
'@ai-oauth-sdk/core': patch
---

Read the token endpoint's response as the untyped JSON it is.

`TokenEndpointResponse` describes what RFC 6749 §5.1 asks for, not what arrives.
Only `access_token` was checked; `refresh_token`, `token_type`, `scope` and
`id_token` were taken on trust, so a number, an object or a `null` in any of
them flowed into the stored credential and out through the credential file
into code entitled to assume a string. A `token_type` of `{}` reached
`createAuthenticatedFetch` and became the literal `[object Object]` in the
`Authorization` header; one containing CR or LF made `Headers.set` throw a bare
`TypeError` from inside `fetch` on the first API call; a non-string `id_token`
reached `decodeJwtPayload`, whose `split('.')` sits above its own `try`, and
threw out of `exchangeCode`. Each is now validated the way the device flow has
always validated its own response, and `token_type` additionally has to be
usable as an RFC 9110 scheme or it falls back to `Bearer`.

Validating `refresh_token` before choosing between it and the stored one also
closes a renewal bug: the carry-forward tested `raw.refresh_token ??
previous?.refreshToken` for truthiness, and because `'' ?? x` is `''`, a gateway
answering a refresh with `"refresh_token": ""` dropped the empty string *and*
the stored token with it, leaving `refresh_failed` on the next call for a
session that was still perfectly renewable.
