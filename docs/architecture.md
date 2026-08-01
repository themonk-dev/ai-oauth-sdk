# Architecture, as it stands today

The registry in `registry-proposal.md` is **not built**. This describes what is
actually in the repo at `0.1.1`, so the two are not confused.

## Providers are hand-written modules

There is no provider registry today. Each provider is its own TypeScript file
calling `defineProvider`, and they are collected into a constant map:

```
packages/core/src/providers/
├── define.ts            defineProvider() — applies conventions
├── index.ts             the `providers` map + resolveProvider()
├── public-client-ids.ts publicClientIds
├── openai.ts  anthropic.ts  google.ts  xai.ts
├── github-copilot.ts  openrouter.ts  qwen.ts
└── microsoft.ts         a factory, not a constant — tenant-scoped endpoints
```

`defineProvider` is thin. It supplies the conventions almost every provider
shares and gets out of the way:

```ts
{
  usePkce: true,
  pkceMethod: 'S256',
  tokenRequest: { style: 'form', includeClientIdInBody: true },
  ...input,
  redirect: { loopbackPath: '/callback', loopbackHost: 'localhost', ...input.redirect },
}
```

So today, adding a provider means writing a module and adding it to the map.
That is exactly what the registry proposal replaces — and the point of this
document is that it replaces *only this layer*.

Note the name collision: `registry.ts` in core is the **`AuthorizationRegistry`**,
which tracks in-flight OAuth flows keyed by `state`. Unrelated to a provider
registry.

## The engine is already provider-agnostic

This is the part worth knowing. `AuthClient` contains no provider-specific
logic. Everything unusual lives behind optional hooks on the descriptor:

```
ProviderConfig                     AuthClient calls it when…
  parseCallback?                   reading what the user pasted back
  buildAuthParams?                 building the authorization URL
  parseTokenResponse?              normalising a non-standard token response
  enrichTokens?                    deriving accountId / email
  apiHeaders?(tokens)              making an API request
```

`openrouter` sends no `client_id`, names its redirect `callback_url` and returns
`{ key }` instead of `access_token` — and none of that appears in `client.ts`.
It is four hooks on one descriptor.

Which means the registry work does not touch the engine. It changes how
descriptors are *authored*, from a module to a JSON entry, and nothing below.

```
                 ┌──────────────────────────────────────────┐
   descriptor ──▶│  AuthClient                              │
   (per provider)│  createAuthorization → completeAuthorization
                 │  login / deviceLogin                     │
                 │  getTokens / getAccessToken / refresh    │──▶ TokenSet
                 │  revoke / logout                         │
                 └────────────┬──────────────┬──────────────┘
                              │              │
                     CallbackReceiver    AuthStorage
                     loopback/popup/     memory/file/
                     redirect/paste/     localStorage/
                     device              SecureStore
```

`CallbackReceiver` and `AuthStorage` are the two portability seams. Swapping the
receiver is what makes the same core work in a CLI, a browser popup and React
Native; swapping storage is what makes it work in a keychain or a file.

## Package layout

```
core                 the engine, providers, receivers — no platform assumptions
├── node             file storage, loopback server, browser launcher, node crypto
├── browser          popup + redirect receivers, localStorage
├── react-native     deep-link / Expo receivers, SecureStore
├── react vue svelte solid   framework bindings over core
├── cli              the `ai-oauth` command
└── ai-oauth-sdk     umbrella package re-exporting the above
```

## What the user actually gets

One shape, for every provider — this part of the "generic output" goal is
already done:

```ts
interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt?: number        // absolute epoch ms, not a TTL
  tokenType: string
  scope?: string
  idToken?: string
  accountId?: string        // normalised across providers
  email?: string            // normalised across providers
  provider: string
  raw: Record<string, unknown>   // the verbatim response; holds a second copy of every credential
}
```

`accountId` and `email` are the interesting fields: providers put them in
wildly different places — Anthropic in `account.uuid` / `account.email_address`,
OpenAI inside a namespaced JWT claim — and `enrichTokens` normalises them so the
consumer does not care.

Most of the time you never touch `TokenSet` directly:

```ts
await client.login({ receiver })     // → TokenSet
await client.getAccessToken()        // → string, refreshed if near expiry
await client.authorizationHeader()   // → "Bearer …"
await client.isAuthenticated()       // → boolean
createAuthenticatedFetch(client)     // → fetch that stays authenticated
```

## Where it falls short of the proposal

`TokenSet` describes a **token**. What a request needs is an `apiKey`, a set of
`headers`, and a `baseUrl` — and today those are three separate things a
consumer assembles by hand:

```ts
tokens.accessToken                  // the credential
client.provider.apiHeaders?.(tokens) // the extra headers
client.provider.apiBaseUrl           // the host — a constant
```

`createAuthenticatedFetch` already assembles all three internally, which is why
it is the recommended path. What is missing is exposing that assembly as a
value:

```ts
interface ResolvedAuth { apiKey?: string; headers?: Record<string, string>; baseUrl?: string }
```

That shape now exists as `ResolvedCredential`, returned by a provider's optional
`exchangeCredential` hook and applied by `createAuthenticatedFetch`, which is
what GitHub Copilot needed: its API credential and its host both come out of a
token exchange rather than from the descriptor. OpenAI never needed it —
`apiBaseUrl` points at `chatgpt.com/backend-api/codex`, the surface those tokens
open, and an API-key account passes `baseUrl` to `createAuthenticatedFetch`.

What is still missing is exposing the resolution as a value a caller can hold,
rather than only as something the fetch does internally.

The other gap is that `TokenSet` models OAuth only. Every tool surveyed models
a discriminated union with an API-key variant, because to a user both answer the
same question. That is deferred for now by your call to ignore API-key auth.

## Summary

| | Today | Proposed |
|---|---|---|
| Provider definition | one TS module each, 8 files | one JSON entry in `providers.json` |
| Engine | provider-agnostic, hook-driven | **unchanged** |
| Return type | `TokenSet` — uniform across providers | plus `ResolvedAuth` for request-time |
| Credential kinds | OAuth only | union with API keys (deferred) |
