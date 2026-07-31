# What the real CLIs actually do

Primary-source notes taken from the shipping code of other AI coding CLIs, plus
live probes of the providers' own endpoints, on 2026-07-31. Everything marked
**verified live** was confirmed by a request made from this repo; everything else
is sourced to a file in a public repository.

The point of the exercise: `ai-oauth-sdk` claims to centralise these flows, so
every claim in a provider descriptor should be traceable to something other than
a guess.

## Sources

| Repo | What it gave us |
|---|---|
| [anomalyco/opencode](https://github.com/anomalyco/opencode) (formerly `sst/opencode`, 191k★) | `packages/opencode/src/plugin/*` — one module per provider; `src/auth/index.ts` — credential union and storage |
| [earendil-works/pi](https://github.com/earendil-works/pi) (81k★) | `packages/ai/src/auth/*` — the closest existing analogue to what this library wants to be |
| [openai/codex](https://github.com/openai/codex) | `codex-rs/login/src/auth/storage.rs` — the `auth.json` shape |

`sst/opencode` and `anomalyco/opencode` are the same repository; the org was
renamed, and the GitHub API returns identical data for both.

## Corrections to our own descriptors

These are places where we are demonstrably wrong, not merely incomplete.

### xAI does publish a client id

`publicClientIds` says xAI "does not publish a client id at all". Both opencode
and pi ship one:

```
b1a00492-073a-47ea-816f-4c329264a828
```

opencode's comment names it "the Grok-CLI client_id that xAI ships for desktop
OAuth flows", and notes that xAI's authorization server *rejects loopback OAuth
from non-allowlisted clients* — so there is no register-your-own path for a CLI
today. **Verified live**: a device-authorization request with this id returns
`200` and a real user code.

**Verified live**: an unregistered id is rejected outright —
`400 {"error":"invalid_client","error_description":"Unknown or disabled client"}`.
That confirms xAI gates on registration; it does *not* by itself confirm
opencode's stronger claim that xAI will not allowlist a third-party CLI, which I
could not test. Either way, the `--client-id=YOUR_CLIENT_ID` line in
`examples/README.md` is misleading today: there is no self-service path to a
working xAI client, so pointing users at one and shipping no default leaves xAI
unusable.

`redirect_uri` must also be exactly `http://127.0.0.1:56121/callback` — the
host:port pair is part of the registration. Our descriptor already pins this.

### xAI is missing a scope

Both CLIs request:

```
openid profile email offline_access grok-cli:access api:access
```

We omit `grok-cli:access`. xAI's discovery document lists it under
`scopes_supported`, alongside several we do not use (`team:read`, `org:read`,
`grok-plugins:access`, `conversations:*`, `workspaces:*`). Whether API access
*requires* `grok-cli:access` is not documented and I could not confirm it
without completing a real login.

### OpenAI has a device flow, and it is not RFC 8628

Our `openai` descriptor sets no `deviceAuthorizationUrl`, so `--device` refuses.
A headless flow exists and is what opencode's "ChatGPT Pro/Plus (headless)"
option drives. It shares no wire format with RFC 8628:

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
   — **JSON** body `{"client_id": "..."}`
   → `{device_auth_id, user_code, interval, expires_at}`
2. User opens `https://auth.openai.com/codex/device` and types `user_code`.
3. `POST https://auth.openai.com/api/accounts/deviceauth/token`
   — **JSON** body `{device_auth_id, user_code}`
   — **403 or 404 means "still pending"**; anything else non-2xx is terminal
   → `{authorization_code, code_verifier}`
4. `POST https://auth.openai.com/oauth/token` — form-encoded, `grant_type=authorization_code`,
   `redirect_uri=https://auth.openai.com/deviceauth/callback`, plus the
   `code_verifier` **the server just handed you**.

**Verified live**: step 1 returned `200` with `user_code` `0V9Q-99N4Z`.

Three details make this incompatible with `pollDeviceToken` as written: JSON
rather than form encoding, pending-as-404 rather than
`error=authorization_pending`, and a server-generated PKCE verifier — the client
never derives one. It needs its own receiver, not a flag on the existing one.

### OpenAI sends three non-standard authorization parameters

```
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=<app name>
```

`originator` is also sent as a **request header** on API calls. None are
documented; all three appear in opencode and in pi. I could not test whether
omitting them breaks the ChatGPT-subscription exchange — `auth.openai.com`
serves a Cloudflare challenge to non-browser clients, so the authorization
endpoint cannot be probed from a script.

### OpenAI's discovery document disagrees with the endpoints everyone uses

`https://auth.openai.com/.well-known/openid-configuration` advertises
`https://auth.openai.com/api/accounts/authorize` and
`.../api/accounts/oauth/token`, and lists **only** `authorization_code` and
`refresh_token` grants — no device code. Every CLI, and this library, uses
`/oauth/authorize` and `/oauth/token` instead. The discovery document is not a
reliable source for this provider; do not "fix" the descriptor to match it.

### GitHub Copilot: two client ids, and a per-account API host

pi uses `Iv1.b507a08c87ecfe98` (ours). opencode uses `Ov23li8tweQw6odWQebz`.
**Verified live**: both return `200` from `https://github.com/login/device/code`.

pi requests scope `read:user` alone; we request `read:user copilot`. GitHub
accepts any scope string at *request* time, so a live probe cannot settle which
is correct — scope validation happens at approval.

More significant: after exchanging the GitHub token at
`https://api.github.com/copilot_internal/v2/token`, the **API base URL comes out
of that response**, not out of a constant:

- individual accounts → `https://api.individual.githubcopilot.com`
- enterprise → `https://copilot-api.<enterprise-domain>`

Our `apiBaseUrl` is a static string on the descriptor, so it cannot express
this. This is the one structural gap, discussed below.

## Providers we do not carry

pi ships two we have never looked at:

- **kimi-coding** — client id `17e5f671-d194-4dfb-9706-5516cb48c098`, issuer
  `https://auth.kimi.com`, a genuine RFC 8628 device grant, API at
  `https://api.kimi.com/coding`. There is no discovery document (**verified
  live**: `404`).
- **radius** — not investigated.

## The shape worth stealing

This is the part that bears on the "one generic output instead of a hundred
formats" goal, and pi has already solved it.

pi's `packages/ai/src/auth/types.ts` reduces every provider to three fields:

```ts
interface ModelAuth {
  apiKey?: string
  headers?: ProviderHeaders
  baseUrl?: string
}
```

with the rule stated in a comment: *"If a value cannot be expressed as `apiKey`,
`headers`, or `baseUrl`, it is provider config, not auth."*

That is the right boundary, and it is what a consumer actually needs — not a
token, but the three things required to make an authenticated request. It also
explains the Copilot problem: `baseUrl` is per-credential, so it belongs to the
*result of resolving auth*, not to the static provider descriptor.

We are most of the way there already. `ProviderConfig` has `apiHeaders(tokens)`
and `apiBaseUrl`; what is missing is a single call that returns all three, with
`baseUrl` allowed to depend on the token.

The second thing worth taking is the credential union. Both pi and opencode
discriminate on a `type` field:

```ts
// opencode — packages/opencode/src/auth/index.ts
type Info = Oauth | Api | WellKnown

// pi — packages/ai/src/auth/types.ts
type Credential = ApiKeyCredential | OAuthCredential
```

We model OAuth only. Every one of these tools treats "paste an API key" as a
peer of "sign in with OAuth", because for the user it is the same decision:
*how do I authenticate to this provider?* Each provider advertises a list of
methods, and the UI is a picker. From opencode's plugin labels:

```
xAI      → "OAuth (SuperGrok Subscription)" | "OAuth (Headless / Remote / VPS)" | "Manually enter API Key"
OpenAI   → "ChatGPT Pro/Plus (browser)"     | "ChatGPT Pro/Plus (headless)"     | "Manually enter API Key"
```

That matches exactly what you saw in the two CLIs.

## Credential storage on disk

| Tool | Path | Shape |
|---|---|---|
| opencode | `<data dir>/auth.json`, mode `0600` | `{ [providerID]: Oauth \| Api \| WellKnown }` |
| pi | `<agent dir>/auth.json`, with a lockfile | `{ [providerId]: ApiKeyCredential \| OAuthCredential }` |
| codex | `$CODEX_HOME/auth.json` | `{ auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, … }, last_refresh }` |

All three are a plain JSON file keyed by provider, `0600`, no OS keychain. Note
codex holds the API key and the OAuth tokens in *one* record with `auth_mode`
discriminating — the same union again.

pi guards writes with a per-provider lock and does refresh *inside* the locked
read-modify-write, so two concurrent requests cannot both refresh and race a
rotated refresh token. Worth checking whether our `AuthClient` has the same
guarantee.

## The post-token step is where the real work is

Every provider that matters has a stage *after* the token exchange that plain
OAuth does not describe. This is the strongest argument for centralising: it is
the part everyone reimplements.

**Anthropic** has two modes off the same login. Pro/Max uses the OAuth access
token directly as a bearer. Console mode makes one more call —
`POST https://api.anthropic.com/api/oauth/claude_cli/create_api_key` with the
OAuth token — and gets back `{raw_key}`, an ordinary long-lived API key. The
authorize request also carries a non-standard `code=true` to render a pasteable
code instead of redirecting, which is the behaviour our `parseAnthropicCallback`
already handles.

**GitHub Copilot** exchanges the GitHub token at
`GET https://api.github.com/copilot_internal/v2/token` (header
`authorization: token <github_token>`) for a session token that expires in
roughly 25–30 minutes, plus the `endpoints` map that selects the API host. Two
things follow: the credential has a *much* shorter life than the OAuth token it
came from, and the base URL is data, not configuration.

**OpenAI**, importantly, has **no** exchange at all. There is no id_token → API
key step. You decode the JWT access token, read `chatgpt_account_id` out of the
namespaced claim `https://api.openai.com/auth`, and call the ChatGPT backend
with `chatgpt-account-id` and `originator` headers. *The absence of that claim
is how you tell an API account from a subscription account.* Our
`decodeJwtPayload` / `getStringClaim` helpers already cover the decoding half.

## Resolved by the research pass

- **xAI's extra parameters are optional.** On the device-authorization request
  `client_id` is the only required field — scope, PKCE and client secret are all
  optional, and `plan`, `referrer` and `nonce` are not needed at all. We can
  ignore them.
- **The xAI client id is xAI's own**, shipped as grok-cli's first-party public
  client; opencode and hermes-agent both reuse it rather than registering their
  own. That settles it as a legitimate `publicClientIds` entry.
- **Anthropic rotates the refresh token on every refresh**, which causes 401
  cascades if two refreshes race. Corroborated by bug reports in three unrelated
  codebases. Our `AuthClient` already dedupes via `#refreshInFlight` *and*
  re-reads storage to catch the cross-process case, so we are covered.
- **Anthropic's token endpoint accepts form *and* JSON.** **Verified live**:
  an invalid grant returns byte-identical `invalid_grant` either way. Other
  clients send JSON; the comment in our descriptor claiming JSON is rejected was
  wrong and has been corrected. No behaviour change — form encoding is fine.
- **No CLI uses the OS keychain.** All of them write plaintext JSON at mode
  `0600`, so reading an existing CLI's credentials is just a file read.

## Still unresolved

- Are OpenAI's three extra authorization parameters
  (`id_token_add_organizations`, `codex_cli_simplified_flow`, `originator`)
  required or cosmetic? The verifiers could not settle this and neither could I
  — `auth.openai.com` serves a Cloudflare challenge to scripted clients.
- Is `grok-cli:access` required for xAI *API* access, or only for Grok-CLI
  features? The discovery document lists the scope but says nothing about which
  are required.
- Which Copilot scope is correct, `read:user` or `read:user copilot`?
- Terms-of-service implications of shipping another vendor's client id. Our
  `publicClientIds` doc comment frames this as the consumer's decision, which
  stays right — but xAI's allowlist means there is no alternative there, which
  weakens "register your own" as advice.
