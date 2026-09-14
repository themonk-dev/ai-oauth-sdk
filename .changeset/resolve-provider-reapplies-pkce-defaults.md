---
'@ai-oauth-sdk/core': patch
---

`resolveProvider()` reapplies the PKCE defaults, so a descriptor that never went through `defineProvider` still gets PKCE.

`defineProvider` turns PKCE on with S256 for everyone who uses it, but nothing makes a descriptor go through it. `isProviderConfig` asks only for an `id` and an `authorizationUrl`, so an inline config — read from a JSON file, assembled by hand and cast, or crossing a package boundary as a plain object — is accepted with `usePkce` and `pkceMethod` simply absent. Absent is falsy, so the flow built an authorization URL with no `code_challenge` at all, silently, and the exchange stopped being bound to the process that started it. PKCE is the whole of what stops a captured authorization code being redeemed, so losing it should take saying so, not forgetting to.

Both fields are now defaulted after the per-call overrides are merged, with `??` rather than a truthiness test: `github-copilot` sets `usePkce: false` deliberately, because GitHub's device flow does not use PKCE, and a truthiness test would read that `false` as "unset", switch PKCE on and break the provider. Anything that already states a value, on the descriptor or in the overrides, keeps it.
