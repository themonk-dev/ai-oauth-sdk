# @ai-oauth-sdk/cli

## 0.1.1

### Patch Changes

- 700d60b: Fix three ways the CLI could hang or refuse a login.

  **`--paste` worked for exactly one provider.** `manualReceiver` fell back to the
  provider's hosted redirect URI and nothing else, so pasting worked for Anthropic
  and threw `configuration_error` for every loopback provider — openai, google,
  xai and openrouter, which is most of them and precisely the case `--paste` is
  meant to rescue. It now synthesises the loopback URI the provider expects,
  including for providers that accept any port, where nothing is listening and the
  value only has to round-trip into the token request unchanged.

  **`login github-copilot` waited for a callback that could never arrive.**
  Providers with no redirect at all can only be completed by device code, but
  without `--device` they were handed a loopback server. The flow is knowable from
  the descriptor, so it is now chosen automatically; `--paste` on one of those
  fails immediately and names `--device` instead of hanging.

  **`--timeout` did nothing on a device login.** `deviceLogin` takes an
  `AbortSignal` rather than a timeout, so the flag was silently dropped and polling
  ran to the provider's own expiry — around fifteen minutes of an apparently frozen
  terminal. It is wired through both login paths now.

- Updated dependencies [700d60b]
  - @ai-oauth-sdk/core@0.1.1
  - @ai-oauth-sdk/node@0.1.1

## 0.1.0

### Minor Changes

- 647fe5f: Initial release.

  Provider-agnostic OAuth 2.0 + PKCE for signing in to AI providers and getting a token
  back, with the per-provider quirks encoded declaratively rather than copy-pasted.

  **Credentials are explicit.** You name the client id at initialization, the way Passport
  does — no provider defaults to one, so nothing presents as a vendor's CLI by accident.
  The published ids are exported as `publicClientIds` to opt into:

  ```ts
  createAuthClient({ provider: "openai", clientId: publicClientIds.openai });
  createAuthClient({ provider: "openai", clientId: "my-registered-client" });
  ```

  **Providers** — OpenAI/ChatGPT, Anthropic/Claude, GitHub Copilot, OpenRouter and Qwen
  ship with published ids; Google/Gemini and xAI/Grok take credentials you register.
  Plus a `microsoft()` factory for Entra ID, `defineProvider()` for anything else, and
  `providerFromDiscovery()` to build one from an OIDC document.

  **Runtimes** — a zero-dependency core that runs in Node, browsers, React Native and
  via CDN, with adapters for each. UI bindings for React, Vue, Svelte and Solid, all
  thin wrappers over one shared observable store.

  **Flows** — loopback server, popup, full-page redirect, deep link, Expo auth session,
  manual paste, and RFC 8628 device code, behind a single pluggable receiver interface.

  **Security** — PKCE (S256) on by default with single-use, TTL-bounded state; a callback
  with no `state` rejected rather than waved through, and a matching one compared in
  constant time; secure randomness required rather than silently faked; credentials
  scrubbed from error messages before they reach your logs; a loopback server restricted
  to `GET`/`HEAD` that sends `no-store`/`no-referrer`; `0600` token files written by
  atomic rename; a CLI that never persists a client secret; and npm provenance
  attestation on every published tarball.

  **Also** — an `ai-oauth-sdk` CLI, a state-keyed handoff so a flow can start and finish in
  different places, deduplicated automatic refresh that survives a second process,
  `createAuthenticatedFetch()` with 401-retry, RFC 7009 revocation, and a pure-JS
  SHA-256 fallback so PKCE works on Hermes without a crypto polyfill.

  Requires Node 22 or newer; builds target ES2022 (Node 22 for the Node-only packages),
  with the CDN bundle held at ES2020.

### Patch Changes

- Updated dependencies [647fe5f]
  - @ai-oauth-sdk/core@0.1.0
  - @ai-oauth-sdk/node@0.1.0
