---
'@ai-oauth-sdk/core': major
'@ai-oauth-sdk/cli': major
'@ai-oauth-sdk/node': major
---

**Breaking.** Providers are named after the product, not the company. Anthropic, Google and
Microsoft are companies; Claude, Gemini and Azure AI are what you sign in to.

| Was | Is |
| --- | --- |
| `provider: 'anthropic'` | `provider: 'claude'` |
| `provider: 'google'` | `provider: 'gemini'` |
| `provider: 'microsoft'` | `provider: 'azure-ai'` |
| `anthropic` | `claude` |
| `google` | `gemini` |
| `microsoft()` | `azureAi()` |
| `MicrosoftProviderOptions` | `AzureAiProviderOptions` |
| `publicClientIds.anthropic` | `publicClientIds.claude` |
| `publicClientIds.google` | `publicClientIds.gemini` |
| `publicClientSecrets.google` | `publicClientSecrets.gemini` |

Labels change with them, so a CLI prompt now says `Claude`, `Gemini` and `Azure AI` rather than
`Claude (Anthropic)`, `Gemini (Google)` and `Microsoft (Entra ID)`.

**Nobody is signed out by this.** Provider ids are the keys stored credentials live under, so the
rename would ordinarily orphan every saved token. A new `previousIds` field on `ProviderConfig`
carries the old id, and `AuthClient` reads it as a fallback and moves what it finds to the new key.
The migration is one-time and silent. It runs per account, so `--account work` sessions come across
too.

To upgrade, replace the identifiers above. Nothing about how a token is obtained, refreshed or
stored changes.
