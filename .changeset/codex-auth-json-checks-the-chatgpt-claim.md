---
'@ai-oauth-sdk/core': patch
---

`codexAuthJson()` now checks that a token carries the ChatGPT claims, not merely that it is a JWT.

The guard only asked whether the chosen token decoded, and the thing Codex actually needs from `id_token` is the `https://api.openai.com/auth` claim it reads the account out of. A well-formed JWT from another issuer — which a `TokenSet` can hold, since `idToken` is whatever the token endpoint returned — passed that check and produced a file Codex parses happily, finds no account in, and then runs unauthenticated against `api.openai.com` with "You didn't provide an API key". The silent failure this guard exists to turn into a thrown error was reachable through it.

The same line also chose `idToken` before validating anything, so a token set holding an opaque id_token beside a claims-carrying access token was refused when it in fact had exactly what Codex needs. Both tokens are now judged and the first one carrying the claim is written, which is what the documented fallback always meant to say.

The claim only has to be present and be an object. Personal and organization tokens carry different sub-keys and an empty one is still a token OpenAI issued for this flow, so holding it to any particular contents would refuse real users.
