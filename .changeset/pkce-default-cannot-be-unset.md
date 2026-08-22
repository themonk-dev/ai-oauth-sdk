---
'@ai-oauth-sdk/core': patch
---

Keep PKCE on when a custom provider hands `usePkce` in as `undefined`.

`defineProvider()` applied its defaults by spreading the caller's input over them, so a key that was *present but explicitly `undefined`* overwrote `usePkce: true` with nothing. That shape is not exotic — `defineProvider({ ...cfg, usePkce: cfg.usePkce })`, or any descriptor assembled from an options object with an unset optional field, produces it, and because `ProviderInput` types the field as optional and this repo sets `exactOptionalPropertyTypes: false`, TypeScript had nothing to say about it.

Every reader tests `provider.usePkce` for bare truthiness, so `undefined` meant no PKCE at all: no verifier derived, no `code_challenge` on the authorization URL, no `code_verifier` on the exchange. Nothing was logged and nothing threw. The library's headline guarantee simply stopped being true for that descriptor.

What it costs is the whole of the defence behind a leaked authorization code. `state` binds a callback to the attempt that started it; it does not stop a code someone else holds from being *redeemed*. PKCE is what does, and it is what `SECURITY.md` rests on when it says a loopback port squatter who wins the race gets a code but never a token. Without it, that squatter — the default shape for a custom CLI provider — has token theft rather than interception, and the ordinary ways a hosted redirect leaks a code (`Referer`, proxy logs, browser history) become redeemable too.

The two defaults now sit after the spread and resolve with `??`, which passes an explicit `false` through untouched — `github-copilot`'s device grant has no PKCE and means it.

`resolveProvider()` applies the same defaults. It is the choke point every client construction passes through, and it was applying neither, so a descriptor that arrived without having been through `defineProvider` — a `as ProviderConfig` cast, or a plain-JavaScript caller — was in the same position however carefully `defineProvider` behaved.

No built-in provider, CLI path or documented example ever produced this; reaching it took an integrator writing a custom descriptor and passing a field they did not have.
