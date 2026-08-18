---
'@ai-oauth-sdk/node': patch
---

Propagate the loopback receiver's refusal through `hybridReceiver()`, so `--paste` is not a way around a squatted port.

`loopbackReceiver()` refuses to start when the address it is about to advertise is already held — a fixed published port taken outright, or the sibling address that a name like `localhost` also resolves to. `hybridReceiver()` started that receiver inside a bare `catch` and dropped it on any failure, on the reasoning that a port that cannot be bound is one of the conditions `--paste` exists for. That reasoning predates the refusal: the sibling case was added later, and the comment was never revisited.

Discarding the loopback half does not leave the login without a redirect URI. `manualReceiver()` synthesises one from the provider, which for a loopback provider with a declared port is exactly the URI that just failed to bind. So a local unprivileged process holding `127.0.0.1:56121` (`xai`) or `[::1]:1455` (`openai`) turned a refusal back into a login: the CLI routes every provider without a hosted callback page through this receiver under `--paste`, printed an authorization URL naming the squatter's socket, and waited at the paste prompt while the browser delivered the code to them and they served whatever page they liked on a URL the user had just been told to trust. As elsewhere, PKCE is what keeps the captured code from being redeemed — the verifier never leaves the victim's process — so this is disclosure, interception and a stalled login rather than token theft, and it is not even that for a descriptor built with `usePkce: false`.

The two failures are now told apart by type: a refusal is an `OAuthError` and is rethrown, and anything else — the EPERM/EACCES/ENOTSUP a sandbox that forbids `listen()` reports — still degrades to the prompt alone. That is deliberately coarser than matching a specific error code, which would be public surface: `start()` throws an `OAuthError` only when it has decided the login should not proceed, and any later reason it decides that propagates without this needing to be revisited again.

`hybridReceiver().start()` therefore gains a rejection case, and `ai-oauth-sdk login <provider> --paste` on a provider with a fixed port now reports the contested port instead of prompting. The sandbox fallback, the race semantics, and providers that paste against a hosted page are unchanged.
