---
'@ai-oauth-sdk/core': patch
---

Replace lone surrogates before percent-encoding, so a malformed token cannot throw a `URIError` out of the SDK.

`errors.ts` opens by promising that every failure this SDK produces is an `OAuthError`. `encodeComponent` broke that. It calls `encodeURIComponent`, which throws a bare `URIError` on an unpaired surrogate, and `JSON.parse` passes lone surrogates through untouched — so a token endpoint answering with `"refresh_token": "rt\ud800"` got that stored verbatim, and every subsequent refresh threw a `URIError` from the token request. `refreshTokens` only rewraps an `OAuthError`, so the `URIError` sailed past the `refresh_failed` wrapper and out to the caller, whose documented `isOAuthError(e) && e.code === 'refresh_failed'` branch — the one that prompts a re-login — never ran. The session was unrecoverable through the API the SDK tells you to use.

Only `style: 'form'` providers were affected; `style: 'json'` survives because `JSON.stringify` escapes the surrogate on its way out.

Lone surrogates are now replaced with U+FFFD before encoding, which is what the URL standard's serialiser — and therefore `URLSearchParams` — already does with them, so the byte-for-byte parity `query.test.ts` asserts is preserved and extended to cover them. It fails closed: the mangled credential is refused by the authorization server and surfaces as an ordinary `refresh_failed`, which is the outcome the caller already knows how to handle. Well-formed surrogate pairs are matched first and pass through untouched.
