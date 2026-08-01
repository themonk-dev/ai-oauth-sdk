---
'@ai-oauth-sdk/node': patch
---

Honour `AI_OAUTH_SDK_NO_BROWSER`. When it is set, `openBrowser()` spawns nothing and
`canOpenBrowser()` reports false, so a receiver that would have launched the machine's URL handler
prints the authorization URL instead. Intended for test suites and CI jobs that drive a login end to
end.
