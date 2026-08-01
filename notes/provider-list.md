# Provider list

Scope: providers with an OAuth 2.0 / PKCE flow. API-key-only integrations are
out of scope.

Every row is backed by one of three kinds of evidence, and the **Evidence**
column says which:

- **live** — I made the request from this repo and got a real response
- **discovery** — fetched the provider's own
  `/.well-known/openid-configuration`
- **source** — read from a shipping open-source CLI, not yet probed

Data regenerated 2026-07-31.

## Ship

### Already shipped (8)

| id | Authorize | Token | Device | Public client id | Evidence |
|---|---|---|---|---|---|
| `openai` | `auth.openai.com/oauth/authorize` | `auth.openai.com/oauth/token` | bespoke¹ | `app_EMoamEEZ73f0CkXaXp7hrann` | live |
| `anthropic` | `claude.ai/oauth/authorize` | `platform.claude.com/v1/oauth/token` | — | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | live |
| `google` | `accounts.google.com/o/oauth2/v2/auth` | `oauth2.googleapis.com/token` | `oauth2.googleapis.com/device/code` ⚠ | none — needs your own | discovery |
| `xai` | `auth.x.ai/oauth2/authorize` | `auth.x.ai/oauth2/token` | `auth.x.ai/oauth2/device/code` | `b1a00492-073a-47ea-816f-4c329264a828` | live |
| `github-copilot` | `github.com/login/oauth/authorize` | `github.com/login/oauth/access_token` | `github.com/login/device/code` | `Iv1.b507a08c87ecfe98` | live |
| `openrouter` | `openrouter.ai/auth` | `openrouter.ai/api/v1/auth/keys` | — | n/a — identified by callback URL | live |
| `qwen` | `chat.qwen.ai/api/v1/oauth2/device/code` | `chat.qwen.ai/api/v1/oauth2/token` | same | `f0304373b74a44d2b584a3fb70ca9e56` | live |
| `microsoft` | `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` | `…/token` | `…/devicecode` | none — per app registration | discovery |

¹ OpenAI's headless flow is not RFC 8628 — see the note below.
⚠ **Google's device endpoint exists and we do not declare it.** One-line fix.

### To add (7)

| id | Authorize | Token | Device | Public client id | Evidence |
|---|---|---|---|---|---|
| `mistral` | `auth.mistral.ai/oauth2/auth` | `auth.mistral.ai/oauth2/token` | `auth.mistral.ai/oauth2/device/auth` | none published | discovery |
| `together` | `auth.together.ai/authorize` | `auth.together.ai/oauth/token` | `auth.together.ai/oauth/device/code` | none published | discovery |
| `sourcegraph` | `sourcegraph.com/.auth/idp/oauth/authorize` | `…/oauth/token` | `…/oauth/device/code` | none published | discovery |
| `kimi` | — (device only) | `auth.kimi.com/api/oauth/token` | `auth.kimi.com/api/oauth/device_authorization` | `17e5f671-d194-4dfb-9706-5516cb48c098` | live |
| `chutes` | `api.chutes.ai/idp/authorize` | `api.chutes.ai/idp/token` | — | none published | discovery |
| `digitalocean` | `cloud.digitalocean.com/v1/oauth/authorize` | — | — | `b1a6c515…cb589f82` | source |
| `snowflake-cortex` | `{account}.snowflakecomputing.com/oauth/authorize` | `…/oauth/token-request` | — | `LOCAL_APPLICATION` | source |

### Bring your own client (4)

These need a client you register yourself — either because they issue an
installed-app secret or because they do not advertise public-client support.
That is a registration requirement, not a reason to exclude them: `clientSecret`
and a consumer-supplied `clientId` are already part of `ProviderConfig`.

| id | Authorize | Token | Device | Evidence |
|---|---|---|---|---|
| `google` | `accounts.google.com/o/oauth2/v2/auth` | `oauth2.googleapis.com/token` | `oauth2.googleapis.com/device/code` | discovery |
| `microsoft` | `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` | `…/token` | `…/devicecode` | discovery |
| `huggingface` | `huggingface.co/oauth/authorize` | `huggingface.co/oauth/token` | `huggingface.co/oauth/device` | discovery |
| `vercel` | `vercel.com/oauth/authorize` | `api.vercel.com/login/oauth/token` | `api.vercel.com/login/oauth/device-authorization` | discovery |

### GitLab Duo (1)

| id | Value |
|---|---|
| authorize | `https://{host}/oauth/authorize` |
| token | `https://{host}/oauth/token` |
| device | `https://{host}/oauth/authorize_device` |
| revoke | `https://{host}/oauth/revoke` |
| scopes | `ai_features`, `ai_workflows`, `api`, `read_user` |
| `host` | defaults to `gitlab.com`; self-managed instances override it |

GitLab advertises the `device_code` grant in `grant_types_supported` but omits
`device_authorization_endpoint` from its discovery document, so the endpoint has
to be known rather than discovered. **Verified live**: `/oauth/authorize_device`
returns `401 invalid_client` for an unregistered id while the paths I guessed
around it return `404` — the endpoint exists.

opencode ships this through an external package, `opencode-gitlab-auth`, which
is why scanning its `src/plugin/` directory missed it.

### Unverified candidate

`minimax` — `account.minimax.io/oauth2/device/code` and `/oauth2/token`, client
id `78257093-7e40-4613-99e0-527b14b39113`, from openclaw's source and confirmed
as OAuth by hermes' documentation ("Browser OAuth login — no API key"). It
publishes no discovery document (confirmed 404) and the sandbox blocked further
device-code probes. Do not ship as verified.

`nous-portal` — hermes documents its own provider as "OAuth, subscription-based"
against `api.nousresearch.com`, but the flow is not spelled out in the source I
read. Needs its own pass.

## Excluded, and why

| Provider | Reason |
|---|---|
| `azure`, `cloudflare` | API key only — opencode's plugins declare `type: "api"` |
| `radius` | pi's own gateway (`client_id: "pi-gateway"`), not a public AI provider |

That is the whole exclusion list now. An earlier draft also excluded
`huggingface` and `vercel` for lacking public-client support — that was
inconsistent, since `google` and `microsoft` lack it too and were kept. The
consistent rule is the one above: needing your own registration is a
documentation note, not a disqualification.

## Public-client support

Whether a provider advertises accepting a client with **no secret**, read from
`token_endpoint_auth_methods_supported` containing `none`.

**Yes:** xai, mistral, together, sourcegraph, chutes
**No:** google, microsoft, huggingface, vercel, gitlab

This decides whether we can ship a default client id, not whether the provider
is usable. Google documents installed-app secrets as non-confidential; Microsoft
and GitLab both let you register a public client explicitly. All five work fine
for a desktop CLI once the consumer registers an application.

## One provider, several methods

Some providers offer a browser flow *and* a headless one, and for OpenAI the two
use entirely different endpoints. That is a property of the provider, not two
providers:

```json
"methods": {
  "browser": { "authorize": "…/oauth/authorize", "token": "…/oauth/token" },
  "device":  { "start": "…/api/accounts/deviceauth/usercode", "poll": "…/deviceauth/token", "trait": "openai-deviceauth" }
}
```

Keeping one id per provider matters for a reason beyond tidiness: credentials
are stored keyed by provider id. Splitting `openai` and `openai-headless` into
separate ids would store two credentials for one account, and signing in one way
would leave the other looking signed-out. Every tool surveyed keys storage by
provider and treats the method as a *choice at login time* — which is also how
`--device` and `--paste` already work in our CLI.

## The three device-flow gaps

Headless support is more uneven than it looks:

1. **`google`** — a standard RFC 8628 endpoint exists in Google's own discovery
   document and our descriptor sets `deviceAuthorizationUrl: undefined`.
   Trivial.
2. **`openai`** — a device flow exists but shares no wire format with RFC 8628:
   JSON bodies, HTTP 403/404 as the "still pending" signal, and the *server*
   generates the PKCE verifier and hands it to you. Needs its own receiver.
3. **`qwen`** — worked only after today's fix; it requires PKCE on the device
   request and we sent none.

`anthropic` and `openrouter` genuinely have no device flow; paste mode is the
correct headless answer for both.

## Sources

### Repositories read

| Repo | Stars | Files used |
|---|---|---|
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 191k | `packages/opencode/src/plugin/{xai,digitalocean,snowflake-cortex}.ts`, `plugin/openai/codex.ts`, `plugin/github-copilot/copilot.ts`, `src/auth/index.ts` |
| [earendil-works/pi](https://github.com/earendil-works/pi) | 81k | `packages/ai/src/auth/types.ts`, `auth/oauth/{anthropic,xai,github-copilot,kimi-coding,openrouter,openai-codex,radius}.ts`, `coding-agent/src/core/auth-storage.ts` |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | — | `extensions/` — 161 providers, 6 with OAuth: `chutes`, `google`, `minimax`, `openai`, `openrouter`, `xai` |
| [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) | 222k | `hermes_cli/*auth*.py` — AI OAuth hosts are OpenAI, xAI, Google, Microsoft only |
| [openai/codex](https://github.com/openai/codex) | — | `codex-rs/login/src/auth/storage.rs`, `login/src/token_data.rs` |

`sst/opencode` and `anomalyco/opencode` are the same repository — the org was
renamed, and the GitHub API returns identical data for both. aider and OpenHands
were surveyed and contributed no AI-provider OAuth clients.

### Discovery documents fetched

`auth.x.ai` · `accounts.google.com` · `auth.openai.com` · `auth.mistral.ai` ·
`auth.together.ai` · `sourcegraph.com` · `api.chutes.ai` · `huggingface.co` ·
`vercel.com` · `login.microsoftonline.com/common/v2.0` · `gitlab.com`

Confirmed absent (404): `chat.qwen.ai`, `auth.kimi.com`, `account.minimax.io`.
`auth.openai.com`'s document is present but **disagrees with the endpoints every
CLI actually uses** — do not treat it as authoritative for that provider.

### Live requests made

Device codes obtained: xAI (`2XR4-6ME2`, `9BMF-MZP2`), GitHub (`893F-7C6A`,
`A68D-0E86`, `F7DF-0028`, `B06D-1693`, `1A4A-52B4`), Qwen (`HIFSNLMQ`,
`U1-JNHOB`), OpenAI (`0V9Q-99N4Z`), Kimi (`QBB0-QTM7`).

Negative controls: an unregistered xAI client id returns
`invalid_client / "Unknown or disabled client"`; Anthropic's token endpoint
returns an identical `invalid_grant` for form and JSON bodies alike, which is
how we established both encodings are accepted.

All codes above are expired and were only ever unapproved authorization
requests — no login was completed and no token was issued.
