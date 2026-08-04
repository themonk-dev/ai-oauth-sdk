---
'@ai-oauth-sdk/browser': minor
---

Add `resolveBrowserFlow()`, `autoReceiver()` and `autoLogin()`, so a browser app stops having to work out which sign-in flow a provider will accept.

Which flow works is a function of the provider's registered client and the origin the page is served from, and until now nothing exposed that. Consumers discovered it by failing: OpenAI's browser sign-in can only ever be the device grant, because its redirect is registered on a fixed loopback port no web origin can present. Claude and Gemini both get a popup on `http://localhost:PORT` — where the page *is* a valid loopback redirect for a client registered with `loopbackPort: 0` — and both must fall back to pasting once deployed, because neither published CLI client will complete a grant against an HTTPS redirect. None of that was discoverable, so apps hardcoded a table and kept it true by hand.

`resolveBrowserFlow(provider, origin)` answers it as a pure function, deriving almost everything from fields the descriptors already carried — `loopbackPort`, `loopbackHost`, `hostedUri`, `deviceFlow` — plus the new `acceptsHttpsRedirect`. Providers built with `defineProvider()` are resolved by the same rule, so this is not a hardcoded table of the built-in seven.

It returns a discriminated union: `popup` with the redirect URI this origin can offer, `device` with the provider's `devicePrerequisite` when it declares one, or `paste` with a typed hint saying whether the code appears on a provider-hosted page or only in the address bar of a redirect that failed to load. The `devicePrerequisite` is worth surfacing: OpenAI's is a setting the user must switch on first, and a UI that hides it produces a code that can never be approved.

`autoReceiver()` is a `CallbackReceiver` that resolves the flow and delegates to `popupReceiver` or `manualReceiver`. It is opt-in — `login()` and `createBrowserAuthClient()` keep the receiver you chose. For a provider that resolves to `device` it fails immediately, naming `deviceLogin()`, rather than opening a popup onto a page with no code on it: a receiver cannot become a different entry point on the client.

`autoLogin(client, options)` is the layer that avoids that trap. It resolves the flow once and calls `login()` or `deviceLogin()` accordingly, returning a `TokenSet` either way. Pass `onCode` to receive the user code and verification URL; it is required exactly when the resolution is `device`, and the error says so before anything is started.
