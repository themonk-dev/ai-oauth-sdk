# Proposal: a provider registry

Goal, in your words: adding or removing a provider should not be an act of
engineering. Today it is a hand-written TypeScript module per provider, and the
research pass showed we would need roughly a dozen more.

## Does the shadcn model apply?

Partly, and it is worth being precise about which part.

shadcn's registry has two separable ideas:

1. **Components are data.** A JSON file describes each item; the index lists
   them. Adding one is a JSON edit.
2. **You install by fetching.** `npx shadcn add button` pulls JSON over HTTP and
   writes files into *your* project, which you then own.

Idea 1 applies cleanly and is most of the win. Idea 2 applies technically but
carries a risk shadcn does not have, discussed at the end.

## What is actually declarative

I checked every provider we ship for which escape hatches it uses:

| Provider | Code hooks used |
|---|---|
| github-copilot, microsoft, qwen | none — pure data |
| google, xai | `enrichTokens` |
| openai | `apiHeaders`, `enrichTokens` |
| anthropic | `apiHeaders`, `enrichTokens`, `parseCallback` |
| openrouter | `buildAuthParams`, `parseTokenResponse` |

`enrichTokens` is the interesting one. In every case it is "pull these fields
out of the response", which is a path map, not logic:

```ts
// anthropic.ts, today
const account = raw['account']
const accountId = record['uuid']
const email = record['email_address']
```

becomes

```json
"claims": { "accountId": "account.uuid", "email": "account.email_address" }
```

That converts **five of eight** providers to pure data. What remains is genuinely
behavioural and should stay code:

- Anthropic's `code#state` paste format
- OpenAI's `chatgpt-account-id` header, read from a JWT claim
- OpenRouter's entire non-standard flow (`callback_url`, no `client_id`, `{key}` response)
- The post-token exchanges: Anthropic `create_api_key`, Copilot `copilot_internal/v2/token`

## The shape

A JSON descriptor plus a small vocabulary of **named behaviours** for the
outliers. A typical provider is JSON only; an unusual one names the behaviour it
needs, and that behaviour lives in code we already have.

```json
{
  "id": "xai",
  "label": "xAI (Grok)",
  "endpoints": {
    "authorize": "https://auth.x.ai/oauth2/authorize",
    "token":     "https://auth.x.ai/oauth2/token",
    "device":    "https://auth.x.ai/oauth2/device/code",
    "revoke":    "https://auth.x.ai/oauth2/revoke",
    "userinfo":  "https://auth.x.ai/oauth2/userinfo"
  },
  "scopes": ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
  "redirect": { "mode": "loopback", "host": "127.0.0.1", "port": 56121, "path": "/callback" },
  "publicClientId": "b1a00492-073a-47ea-816f-4c329264a828",
  "clientIdNote": "grok-cli's first-party client. xAI rejects unregistered clients, so there is no register-your-own path.",
  "api": { "baseUrl": "https://api.x.ai/v1" },
  "claims": { "accountId": "sub", "email": "email" }
}
```

and an outlier:

```json
{
  "id": "anthropic",
  "traits": { "callback": "code-hash-state", "postToken": "anthropic-console-key" }
}
```

`traits` is a closed set with a TypeScript union type, so a typo is a compile
error and the JSON stays checkable against a schema. This is the part that keeps
it from degenerating into config-as-code.

### One file, not one per provider

Every descriptor lives in a single `providers.json` keyed by id — not
`registry/xai.json`, `registry/openai.json` and so on. shadcn splits per item
because you install items individually; we load all of them, so splitting buys
nothing and costs a file per provider forever.

Net effect on the codebase:

```
  before                          after
  providers/openai.ts             providers.json      ← all ~14 providers
  providers/anthropic.ts          registry.ts         ← loader + interpolation
  providers/google.ts             traits.ts           ← the code hooks that survive
  providers/xai.ts
  providers/github-copilot.ts
  providers/openrouter.ts
  providers/qwen.ts
  providers/microsoft.ts
  providers/define.ts
```

Nine files become three, and doubling the provider count adds no files at all.
Adding a provider is one JSON object.

### Endpoints need interpolation

Microsoft is already a factory function because Entra's endpoints are
tenant-scoped, and Snowflake is the same shape per account. So the registry
needs one small feature beyond static strings:

```json
"endpoints": { "authorize": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize" },
"variables": { "tenant": { "default": "common" } }
```

`resolveProvider('microsoft', { tenant: 'contoso' })` fills them in. Without
this, those two providers cannot be data and we would keep hand-written modules
for them — which is exactly what we are trying to stop doing.

## Client ids: the change you asked for

Today every provider requires an explicit `clientId` — that was a deliberate
decision (commit `5901ca0`, "Passport model"), on the reasoning that using a
vendor's id means *presenting your application as that vendor's CLI*, which is
the consumer's call to make, not ours.

You want a fallback to the public default. That reverses the decision, and I
think you are right to, for a reason the research produced: **xAI rejects
unregistered clients.** There is no register-your-own path, so "supply your own
id" is not advice, it is a dead end. The current `examples/README.md` line
telling users to pass `--client-id=YOUR_CLIENT_ID` for xAI does not work.

Proposed resolution that keeps the original intent without the dead end:

- `clientId` stays optional everywhere — SDK and CLI.
- If omitted, fall back to `publicClientId` from the registry.
- If there is no public id either, throw as today.
- The resolved credential reports its origin, so a consumer can tell:
  `client.clientIdSource === 'explicit' | 'public-default'`.
- The registry carries `clientIdNote` per provider, and the CLI prints it once
  on first use of a public default — so the "you are presenting as their CLI"
  warning survives, as information rather than as an obstacle.

## The credential union

Separate from the registry but the same theme. Every tool surveyed models this
as a discriminated union, because to a user "paste an API key" and "sign in" are
one question:

```ts
type Credential =
  | { type: 'oauth'; access: string; refresh?: string; expires?: number; accountId?: string }
  | { type: 'api_key'; key: string }
```

and resolves it to the three things a request actually needs — pi's rule, which
I would adopt verbatim:

```ts
interface ResolvedAuth { apiKey?: string; headers?: Record<string, string>; baseUrl?: string }
// If it cannot be expressed as apiKey, headers or baseUrl, it is provider config, not auth.
```

`baseUrl` being part of the *result* rather than the descriptor is what fixes
GitHub Copilot, whose API host comes out of the token exchange.

## Provider list

Scope: OAuth/PKCE providers only. API-key-only integrations are out.

I built this by reading the surveyed repos and then sweeping candidate hosts for
`/.well-known/openid-configuration`, which is authoritative and cheap. Every row
below is backed by a discovery document I fetched or a live request I made.

### Ship these — public client, PKCE, device flow

`none` in `token_endpoint_auth_methods_supported` means the provider accepts a
public client with no secret, which is what a CLI needs.

| Provider | Authorize | Device | Notes |
|---|---|---|---|
| **openai** | `auth.openai.com/oauth/authorize` | bespoke, not RFC 8628 | shipped |
| **anthropic** | `claude.ai/oauth/authorize` | — | shipped |
| **xai** | `auth.x.ai/oauth2/authorize` | ✓ | shipped; add `grok-cli:access` |
| **github-copilot** | `github.com/login/oauth/authorize` | ✓ | shipped |
| **openrouter** | `openrouter.ai/auth` | — | shipped; non-standard throughout |
| **google** | `accounts.google.com/o/oauth2/v2/auth` | ✓ | shipped |
| **qwen** | `chat.qwen.ai/api/v1/oauth2/device/code` | ✓ | shipped; fixed today |
| **mistral** | `auth.mistral.ai/oauth2/auth` | `oauth2/device/auth` | **new** |
| **together** | `auth.together.ai/authorize` | `oauth/device/code` | **new** |
| **sourcegraph** | `sourcegraph.com/.auth/idp/oauth/authorize` | ✓ | **new** — Amp/Cody |
| **kimi** | `auth.kimi.com/api/oauth/device_authorization` | ✓ | **new** — verified live, code `QBB0-QTM7` |
| **digitalocean** | `cloud.digitalocean.com/v1/oauth/authorize` | — | **new** — inference at `inference.do-ai.run/v1` |
| **minimax** | `account.minimax.io/oauth2/device/code` | ✓ | **new** — from openclaw; source-verified only, see below |
| **chutes** | `api.chutes.ai/idp/authorize` | — | **new** — discovery doc confirmed; no public client id shipped |

MiniMax is the one row I could not confirm with a live request: the sandbox
blocked further device-code probes after I had made a number of them this
session, which is a reasonable line and I did not work around it. Its endpoints
and client id come from openclaw's source, and it publishes no discovery
document, so treat it as unverified until someone completes a real login. It
also has a separate China host, `account.minimaxi.com`.

### Templated — endpoints contain a runtime variable

| Provider | Template |
|---|---|
| **microsoft** | `login.microsoftonline.com/{tenant}/oauth2/v2.0/…` |
| **snowflake-cortex** | `{account}.snowflakecomputing.com/oauth/…` |

We already handle Microsoft by making it a *factory function* rather than a
constant, which is why it is absent from the `providers` map. That is the right
behaviour and the registry must keep it: **descriptors need variable
interpolation**, or these two cannot be data.

### Flagged — metadata says confidential client

| Provider | Concern |
|---|---|
| **huggingface** | `oauth/authorize` + device, but auth methods are `client_secret_basic`/`post` only |
| **vercel** | `vercel.com/oauth/authorize` + device, same |

Neither advertises `none`, which suggests they require a client secret and are
therefore unsuitable for a public CLI client. Metadata is not always honest
about this — plenty of providers accept public PKCE clients without advertising
it — but confirming would mean registering an app with each. I would leave both
out until someone actually wants them.

### Excluded

- **azure, cloudflare** (opencode) — API key only.
- **radius** (pi) — client id `pi-gateway`, no hardcoded host; it is pi's own
  gateway rather than a public AI provider.
- **gitlab** — PKCE but no device flow, and not an inference provider.
- **huggingface, vercel** — see the confidential-client note above.

### What the survey says about scope

openclaw ships **161 provider extensions and exactly six of them use OAuth**:
`chutes`, `google`, `minimax`, `openai`, `openrouter`, `xai`. hermes-agent's
only AI-provider OAuth hosts are OpenAI, xAI, Google and Microsoft — everything
else in it (Feishu, Lark, DingTalk, Spotify, Vercel) is unrelated to inference.

That ratio is the useful finding. OAuth is the rare case; the long tail of AI
providers is API keys. Ignoring API-key auth, as you said, keeps the registry
around a dozen entries rather than a hundred and fifty — which is what makes
"one JSON file" a sane design rather than a growing liability.

## On removing Qwen

Your instinct was that there is no way to authenticate it. That was true a few
hours ago and is not any more — the flow was broken because we never sent PKCE,
and it now returns real device codes (`HIFSNLMQ`, `U1-JNHOB` in testing).

Facts either way: no other surveyed tool ships Qwen; Alibaba's own `qwen-code`
does; the free tier was discontinued in April 2026, so new sign-ups may be
refused regardless. It is already marked `experimental`.

My recommendation is to keep it, on the grounds that it now demonstrably works,
that removing it from a published package is a breaking change, and that under
this proposal a provider costs one JSON file. But it is a judgement call and I
will remove it if you would rather.

## The risk in idea 2

If the registry is fetched at runtime rather than bundled, then whoever serves
it controls `authorize` and `token` URLs for every consumer. A compromised
registry redirects the authorization endpoint and harvests codes — and unlike a
compromised npm package, no lockfile or provenance attestation catches it.

Given the effort we spent on the release pipeline, I would not undermine it
here. Recommendation:

- **Bundle the registry in the package by default.** This is idea 1, and it is
  where the win is.
- If remote registries are supported at all, make them opt-in, pinned by
  integrity hash, never auto-updating, and never the default source.

Provider constants do rot, which is the argument for fetching — but the answer
to that is a fast patch release, not a live channel into the auth path.
