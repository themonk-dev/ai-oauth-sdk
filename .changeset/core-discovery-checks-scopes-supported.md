---
'@ai-oauth-sdk/core': patch
---

Validate `scopes_supported` before building a provider from a discovery document.

It was the only field in the document that reached the descriptor with no check at all, and every
way of it being malformed failed badly. A deployment emitting the space-delimited string
`"openid profile"` rather than an array — some do — got as far as `scopes.join is not a function`,
a bare `TypeError` thrown out of `client.login()` on remote input rather than an `OAuthError` you
could branch on. An object or a number was quieter and worse: the descriptor carried the junk, the
`scope` parameter was dropped from the authorization request entirely, and the sign-in silently
asked for whatever the authorization server's default scopes happen to be. `[1, 2]` produced
`scope=1+2`.

Anything that is not a non-empty array of non-empty strings is now ignored, and the provider falls
back to `['openid']` — the same default a document listing no scopes at all already got. A
well-formed list is still used exactly as before, so a working discovery-based provider is
unaffected. Pass `scopes` yourself if you want something other than what the document advertises.
