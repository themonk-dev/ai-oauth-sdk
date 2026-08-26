---
'@ai-oauth-sdk/core': patch
---

Stop treating every HTTP 400 from a revocation endpoint as a successful revocation.

`revokeToken()` accepted any 400, on the stated grounds that "`unsupported_token_type` and an unknown token are both terminal". RFC 7009 says close to the opposite. §2.2 makes **200** the answer both for a token that was revoked and for one the server does not recognise — an unknown token is a success, and the server is required to say so with a 200. Every code §2.2.1 defines for a 400 (`invalid_request`, `invalid_client`, `unauthorized_client`, `unsupported_token_type`) means the revocation did *not* happen, and `unsupported_token_type` says so most plainly: the server refuses to revoke tokens of that type, and the credential is still live. So `logout({ revoke: true })` could report a session as ended while it was still usable.

Rejecting every 400 would be wrong in the other direction, and not hypothetically. Google's revocation endpoint — the one `providers/gemini.ts` declares, so this is a bundled path — answers `400 {"error": "invalid_token"}` for a token it has already forgotten, which is exactly the case the RFC calls a success. A blanket rejection would break idempotent revocation for the primary bundled provider.

The body now decides. A 400 whose `error` is absent or `invalid_token` resolves; `unsupported_token_type`, `invalid_client`, `unauthorized_client` and `invalid_request` throw `token_request_failed` with the status attached. A body that is not JSON, is empty, or cannot be read at all keeps the previous leniency, since a server that sends one has told us nothing and a parse error is no reason to invent a failure. 200 still resolves and every other failure status still throws. The doc comment's account of the RFC has been corrected to match.
