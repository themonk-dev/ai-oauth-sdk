# Using the token

Signing in is the easy half. This is what to do with what comes back.

## Short answer

Pass `createAuthenticatedFetch(client)` as the `fetch` option of whatever client
you already use. The Vercel AI SDK, the OpenAI SDK and the Anthropic SDK all
accept one.

```ts
import { createOpenAI } from '@ai-sdk/openai'
import { createAuthenticatedFetch } from '@ai-oauth-sdk/core'
import { createNodeAuthClient } from '@ai-oauth-sdk/node'

const client = createNodeAuthClient({ provider: 'openai', clientId })

const openai = createOpenAI({
  apiKey: 'unused',                        // the SDK wants one; our fetch replaces it
  baseURL: client.provider.apiBaseUrl,
  fetch: createAuthenticatedFetch(client),
})

const { text } = await generateText({ model: openai.responses('gpt-5.5'), prompt: 'hi' })
```

`openai.responses`, not `openai.chat`: the ChatGPT surface serves `/responses`
and nothing else. `fetchCodexModels(client)` returns the slugs the signed-in
account can actually use, which is worth calling rather than hardcoding one,
because the set depends on the user's plan.

Verified against `ai` + `@ai-sdk/openai` with a stub provider: the request
carries the OAuth bearer, the provider's own extra headers are attached, and an
expired token is refreshed mid-call without the caller noticing.

## Does the Vercel AI SDK support OAuth tokens?

Not as a first-class concept — every `@ai-sdk/*` provider is built around an
`apiKey`. But all of them accept `fetch`, `headers` and `baseURL`, and that is
enough. It is also exactly what the other CLIs do; opencode's own comment on its
Snowflake provider says the quiet part out loud:

> For OAuth tokens, the plugin auth loader's combined fetch handles OAuth
> refresh … in one place.

Three ways to wire it, worst to best:

| Approach | Refreshes? | Notes |
|---|---|---|
| `apiKey: tokens.accessToken` | **no** | Captured once. Dies at expiry, mid-session. opencode uses this where the provider is a plain bearer and it re-reads per request. |
| `headers: { Authorization: … }` | **no** | Same problem; a static object is built once. |
| `fetch: createAuthenticatedFetch(client)` | **yes** | Refreshes before expiry, retries once on 401, adds provider headers. |

Only the third survives a long-running session, which is the whole point: a
token that expires after twenty minutes is not something you want to have
captured in a closure.

## A bug this uncovered

Until `0.1.2`, the obvious wiring above **silently sent the wrong credential**.

`createAuthenticatedFetch` used to let an `Authorization` header set by the
caller win. That is reasonable when you call it yourself. It is wrong when the
caller is an SDK that sets `Authorization` from its own `apiKey` before handing
control over — which the AI SDK does, *even when `apiKey` is empty or omitted
entirely*. All three variants sent `Bearer <placeholder>` while the library
dutifully refreshed the real token and attached it to nothing.

The managed token now wins by default. Pass `respectCallerAuthorization: true`
for the old behaviour.

## Per-provider gotchas

The token alone is not always enough.

**OpenAI** — a ChatGPT-subscription token does not work against
`api.openai.com`, which wants an API key and answers this token with
`403 Missing scopes: api.model.read`. It works against
`chatgpt.com/backend-api/codex`, which is where the Codex CLI sends its
requests, and that is what `apiBaseUrl` now points at.

Four things beyond the bearer are needed there, and the descriptor supplies all
of them: a `chatgpt-account-id` header, an `OpenAI-Beta` and an `originator`
header, a `client_version` query parameter, and a rewritten request body. That
last one is the awkward part. The backend runs stateless, so a `/responses` call
has to set `store: false`, configure `reasoning`, ask for
`reasoning.encrypted_content` in `include`, carry no server-side ids on its
input items, and send no `max_output_tokens`. Miss any of it and the call
returns 200 with an empty stream rather than an error.
`normalizeCodexResponsesBody` does that, and the provider applies it through
`transformRequestBody`.

*The absence of the `https://api.openai.com/auth` claim is how you tell an API
account from a subscription one.* For an API account, pass
`baseUrl: 'https://api.openai.com/v1'` to `createAuthenticatedFetch`.

Speech to speech is not reachable this way. ChatGPT's voice transport wants a
token minted for the ChatGPT *web* client, which comes from a browser session
cookie rather than from an OAuth grant, so no scope or header here opens it. Use
an API key and the documented `/v1/realtime/calls` interface for that.

**GitHub Copilot** — two things. The API host comes out of the token exchange
(`api.individual.githubcopilot.com`, or an enterprise host), so it is data, not
configuration. And the session token lives ~25 minutes, so refresh is mandatory
rather than a nicety — the `fetch` approach is the only one that works.

**Anthropic** — OAuth bearers need `anthropic-beta: oauth-2025-04-20` alongside
`anthropic-version`. Our descriptor already emits both through `apiHeaders`, and
`createAuthenticatedFetch` attaches them; a hand-rolled `headers` object will
not.

**OpenRouter** — the flow returns a normal API key rather than an OAuth token,
so there is nothing to refresh and `apiKey:` is genuinely fine.

The pattern across all four: what a request needs is not a token, it is an
`apiKey`, a set of `headers`, and a `baseUrl` — which is the argument for the
`ResolvedAuth` shape in the registry proposal, and specifically for `baseUrl`
being part of the *result* of resolving a credential rather than a constant on
the descriptor.

## Not just the AI SDK

Anything taking a `fetch` works the same way — the official OpenAI SDK
(`new OpenAI({ fetch })`), the Anthropic SDK, `openai-compatible` providers, or
plain `fetch` against a REST endpoint:

```ts
const api = createAuthenticatedFetch(client)
const models = await api('/models').then((r) => r.json())
```

Relative paths resolve against the provider's `apiBaseUrl`, which is why that
call has no host in it.
