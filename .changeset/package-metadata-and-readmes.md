---
'ai-oauth-sdk': patch
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/cli': patch
'@ai-oauth-sdk/node': patch
'@ai-oauth-sdk/browser': patch
'@ai-oauth-sdk/react-native': patch
'@ai-oauth-sdk/react': patch
'@ai-oauth-sdk/vue': patch
'@ai-oauth-sdk/svelte': patch
'@ai-oauth-sdk/solid': patch
---

Point every package at the documentation site. Nine of the ten had no `homepage`, so npm showed no
Homepage link at all, and the tenth pointed back at the repository README. Each now links to its own
page on the docs site, and every package gets a `bugs` URL so npm shows an Issues link too.

No code changes. The READMEs were also rewritten for readability.
