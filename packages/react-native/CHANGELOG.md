# @ai-oauth-sdk/react-native

## 1.2.0

### Patch Changes

- 8b51237: Bind deep-link callbacks to the attempt that started them, and stop replaying the launch URL.

  A custom URL scheme is not a private channel. Any other app on the device, and any web page the user follows a link from, can send `myapp://auth/callback?...` into the receiver, and it settled the login from anything whose path matched the redirect URI. A single unsolicited `?error=access_denied` therefore cancelled a sign-in on demand — the client's own `state` comparison only guards the success path, so a `wait()` that rejects is a failed login whatever the callback was. The loopback receiver is bound to its attempt the same way, in this release, and additionally turns away the subresource form of the same request using the `Sec-Fetch-*` headers a browser attaches; a custom scheme carries no such headers to judge by, so `state` is the whole of it here.

  The same hole was reachable without anyone sending anything. `wait()` read `getInitialURL()` unconditionally, and that source does not drain: it keeps returning the URL that cold-started the app for the life of the process. A callback bound to nothing was replayed into every later login in that process.

  Callbacks are now matched to the attempt by `state`, read from the authorization URL handed to `present()` so the two cannot drift, and one that disagrees is dropped rather than settling the login. A callback carrying no `state` where one was presented is dropped too: on a custom scheme "not ours" is the default, and RFC 6749 §4.1.2.1 requires `state` to be echoed on error responses as well as successful ones, so nothing legitimate is turned away. A provider that ignores that rule leaves the login pending rather than failing it, which is what `timeoutMs` and `signal` are for. A provider that sends no `state` at all leaves nothing to compare, and its callbacks are still taken as they come. The redirect URI is now compared by whole path rather than by prefix, so `myapp://auth/callbackXYZ` is no longer treated as the callback screen.

  `parseQuery` is exported from core for this: a receiver reading a param back out of an authorization URL needs the same parser the URL was built with, and bare React Native cannot reliably reach for `URLSearchParams` to do it.

  The documented cold-start resume was corrected rather than kept. It could not work and never could: the relaunched app calls `createAuthorization()` again, which mints a fresh `state`, so the URL from before the kill belongs to an attempt that no longer exists. Finishing a flow the OS interrupted means handing the URL to `completeAuthorization({ callbackUrl })` yourself, with storage that survives the restart and within the authorization TTL.

- Updated dependencies [8b51237]
- Updated dependencies [8b51237]
- Updated dependencies [8b51237]
  - @ai-oauth-sdk/core@1.2.0

## 1.1.3

### Patch Changes

- Updated dependencies [e975c27]
  - @ai-oauth-sdk/core@1.1.3

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
