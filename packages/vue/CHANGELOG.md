# @ai-oauth-sdk/vue

## 1.1.2

### Patch Changes

- Updated dependencies [e0f0ee6]
- Updated dependencies [e0f0ee6]
  - @ai-oauth-sdk/core@1.1.2

## 1.1.1

### Patch Changes

- Updated dependencies [3f7b8b5]
  - @ai-oauth-sdk/core@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [a13a33d]
  - @ai-oauth-sdk/core@1.1.0

## 1.0.2

### Patch Changes

- Updated dependencies [074e5a4]
  - @ai-oauth-sdk/core@1.0.2

## 1.0.1

### Patch Changes

- @ai-oauth-sdk/core@1.0.1

## 1.0.0

### Patch Changes

- 63f7a74: Point every package at the documentation site. Nine of the ten had no `homepage`, so npm showed no
  Homepage link at all, and the tenth pointed back at the repository README. Each now links to its own
  page on the docs site, and every package gets a `bugs` URL so npm shows an Issues link too.

  No code changes. The READMEs were also rewritten for readability.

- Updated dependencies [63f7a74]
- Updated dependencies [380a105]
- Updated dependencies [380a105]
  - @ai-oauth-sdk/core@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [596450f]
- Updated dependencies [3b6f333]
  - @ai-oauth-sdk/core@0.3.0

## 0.2.1

### Patch Changes

- @ai-oauth-sdk/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [4848812]
- Updated dependencies [4848812]
- Updated dependencies [4848812]
- Updated dependencies [4848812]
  - @ai-oauth-sdk/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [700d60b]
  - @ai-oauth-sdk/core@0.1.1

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
