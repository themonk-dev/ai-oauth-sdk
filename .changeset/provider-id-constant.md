---
'@ai-oauth-sdk/core': minor
---

Added `ProviderId`, a named constant for the built-in ids.

```ts
import { createAuthClient, ProviderId, publicClientIds } from '@ai-oauth-sdk/core'

createAuthClient({
  provider: ProviderId.GitHubCopilot,
  clientId: publicClientIds[ProviderId.GitHubCopilot],
})
```

Every value is the plain kebab-case id, so this is a way to autocomplete the string rather than a
new thing to pass. `provider: 'github-copilot'` keeps working, custom ids are still ordinary
strings, and nothing accepts an id it did not accept before.

Azure AI has no entry, because it has no fixed id to name. Its endpoints are tenant-scoped, so the
descriptor comes from `azureAi({ tenant })`.
