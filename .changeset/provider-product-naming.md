---
'@ai-oauth-sdk/core': minor
'@ai-oauth-sdk/cli': patch
'@ai-oauth-sdk/node': patch
---

Name providers after the product rather than the company. Labels are now `Claude`, `Gemini` and
`Azure AI`, where they were `Claude (Anthropic)`, `Gemini (Google)` and `Microsoft (Entra ID)`.
Those labels are what a CLI prompt shows, so this is the name users actually read.

`azureAi()` replaces `microsoft()`, and `claude` is exported alongside `anthropic`. Both old names
still work: `microsoft` is the same function under a deprecated alias, `MicrosoftProviderOptions`
is a type alias for `AzureAiProviderOptions`, and `claude` and `anthropic` are the same object.

Provider ids are deliberately unchanged. `anthropic`, `google` and `microsoft` are the keys stored
credentials are saved under and the names passed to `createAuthClient`, so renaming them would sign
every user out and break every consumer. Nothing about how a token is obtained or stored changes.
