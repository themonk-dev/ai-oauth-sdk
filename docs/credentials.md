# Credentials

Every provider needs a client id, and you always name it explicitly — no
provider defaults to one. This page lists the published values so you can pass
the same credential from the SDK that the CLI uses by default.

> [!IMPORTANT]
> These identify **the vendor's own CLI**. Using one means presenting your
> application as that CLI. That is a decision only you can make, which is why it
> is an argument rather than a default. See the [disclaimer](../DISCLAIMER.md).

## The table

| Provider | `clientId` | `clientSecret` | Source |
|---|---|---|---|
| `openai` | `publicClientIds.openai` | — | Codex CLI |
| `anthropic` | `publicClientIds.anthropic` | — | Claude Code |
| `github-copilot` | `publicClientIds['github-copilot']` | — | VS Code Copilot extension |
| `qwen` | `publicClientIds.qwen` | — | qwen-code |
| `google` | `publicClientIds.google` | `publicClientSecrets.google` | gemini-cli |
| `xai` | `publicClientIds.xai` | — | grok-cli |
| `openrouter` | *none* | — | identified by callback URL alone |
| `microsoft` | **yours** | optional | your Entra ID app registration |

Raw values, if you need to paste one into a config file or another language:

| Provider | Value |
|---|---|
| `openai` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| `anthropic` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| `github-copilot` | `Iv1.b507a08c87ecfe98` |
| `qwen` | `f0304373b74a44d2b584a3fb70ca9e56` |
| `google` (id) | `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com` |
| `google` (secret) | `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` |
| `xai` | `b1a00492-073a-47ea-816f-4c329264a828` |

## From the SDK

```ts
import { createAuthClient, publicClientIds, publicClientSecrets } from 'ai-oauth-sdk/node'

const claude = createAuthClient({
  provider: 'anthropic',
  clientId: publicClientIds.anthropic,
})

// Google is the only one that also needs a secret.
const gemini = createAuthClient({
  provider: 'google',
  clientId: publicClientIds.google,
  clientSecret: publicClientSecrets.google,
})

// OpenRouter needs neither — the callback URL is the identifier.
const openrouter = createAuthClient({ provider: 'openrouter' })
```

The one-shot helper takes the same options:

```ts
import { login, publicClientIds } from 'ai-oauth-sdk/node'

const { accessToken } = await login('openai', { clientId: publicClientIds.openai })
```

## From the CLI

The CLI opts into these for you — it *is* an application, so it can make that
choice once on your behalf:

```bash
ai-oauth-sdk login openai          # uses publicClientIds.openai
ai-oauth-sdk login google          # uses the published id and secret
```

Override either per invocation:

```bash
ai-oauth-sdk login google --client-id '<id>.apps.googleusercontent.com' \
                          --client-secret '<secret>'
```

Prefer the environment variable for the secret — a flag is visible in `ps` and
lands in shell history:

```bash
AI_OAUTH_SDK_CLIENT_SECRET='<secret>' ai-oauth-sdk login google
```

The CLI never writes a client secret to the credential file. It is read fresh
each invocation, so a value that was briefly visible in `ps` does not become a
durable copy on disk.

## Bringing your own

Register your own client wherever the provider offers it, and you present as
yourself rather than as someone else's CLI:

| Provider | Where |
|---|---|
| `google` | Google Cloud console → Credentials → OAuth client → **Desktop app** |
| `microsoft` | Entra ID → App registrations → public client / native |
| `github-copilot` | GitHub → Developer settings → OAuth Apps |

Two have no self-service path for a desktop CLI, so the published id is the only
one that works:

- **xAI** rejects any client it has not allowlisted — `invalid_client`,
  *"Unknown or disabled client"*.
- **OpenAI** and **Anthropic** issue CLI clients to their own tools; there is no
  registration form for a third-party equivalent.

## Scopes

Defaults are the minimum for chat. Widen them per client:

```ts
createAuthClient({
  provider: 'anthropic',
  clientId: publicClientIds.anthropic,
  scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:file_upload'],
})
```

`anthropic` defaults to `user:inference user:profile user:sessions:claude_code`.
Claude Code additionally requests `org:create_api_key`, `user:file_upload` and
`user:mcp_servers` — none is needed to send a prompt, and `org:create_api_key`
in particular lets any leaked token mint durable organization API keys that
outlive the OAuth session, so ask for it only if you want it.

On the CLI, `--scopes` takes a comma- or space-separated list:

```bash
ai-oauth-sdk login anthropic --scopes 'user:inference,user:profile,user:file_upload'
```

## If a credential stops working

Published values can be rotated by the vendor at any time, and automated secret
scanning may prompt that for Google's. Nothing breaks structurally — pass your
own with `--client-id` / `--client-secret`, the environment variable, or the SDK
options above. An `invalid_client` error is the signal.
