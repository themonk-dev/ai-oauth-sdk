---
'@ai-oauth-sdk/core': minor
---

Make an OpenAI token usable for inference. `apiBaseUrl` pointed at
`https://api.openai.com/v1`, which answers every token this provider mints with
`403 Missing scopes: api.model.read`. It now points at
`https://chatgpt.com/backend-api/codex`, the surface a ChatGPT sign-in actually
opens, and the descriptor supplies the rest of what that endpoint needs: the
`OpenAI-Beta` and `originator` headers, a `client_version` query parameter, and
a `/responses` body rewritten for a stateless backend that would otherwise
answer with an empty stream.

Two new optional hooks on `ProviderConfig` carry that, and both are honoured by
`createAuthenticatedFetch`: `apiQuery(tokens)` adds query parameters, and
`transformRequestBody(url, body, tokens)` rewrites a JSON request body. Bodies
that are streams, form data or bytes are passed through untouched.

Also adds `fetchCodexModels(client)`, which lists the model slugs the signed-in
account can use. The set depends on the user's plan and on `client_version`, so
it is worth asking rather than hardcoding a slug.

Pass `baseUrl: 'https://api.openai.com/v1'` to `createAuthenticatedFetch` for an
API-key account, whose token carries no `https://api.openai.com/auth` claim.
