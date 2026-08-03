---
'@ai-oauth-sdk/core': patch
---

Echo `code_challenge_method` on the OpenRouter token exchange. Its key endpoint
requires the PKCE method on the exchange as well as the authorization request,
and rejects the exchange with `400 Invalid code_challenge_method` without it.
