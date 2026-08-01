# @ai-oauth-sdk/node

## 0.2.1

### Patch Changes

- 076f8c0: Honour `AI_OAUTH_SDK_NO_BROWSER`. When it is set, `openBrowser()` spawns nothing and
  `canOpenBrowser()` reports false, so a receiver that would have launched the machine's URL handler
  prints the authorization URL instead. Intended for test suites and CI jobs that drive a login end to
  end.
  - @ai-oauth-sdk/core@0.2.1

## 0.2.0

### Minor Changes

- 4848812: Make every flow either work or say why it cannot.

  **Anthropic no longer makes you paste.** It defaulted to `hosted` redirect mode,
  so the only route was copying a code out of the browser — while Claude Code
  itself runs a local server and catches the callback. It now defaults to
  `loopback` on an ephemeral port and sends `code=true`, matching the official
  client. The hosted page stays declared, and `defaultReceiver` routes any
  provider that has one to the paste prompt once there is no local browser —
  otherwise a remote box's `localhost` URI reaches a browser that cannot answer
  it, and Anthropic has no device flow to fall back on.

  **`--paste` no longer strands a local browser.** For a provider with no hosted
  page — OpenAI, Google — the redirect went to a loopback port nothing was
  listening on, so the browser showed "This site can't be reached" and the code
  was only readable out of the address bar. We already know the port, so
  `hybridReceiver` binds it and races the two: the server finishes the login when
  the browser is on this machine, the paste prompt when it is not. On a laptop
  nothing is copied at all; over SSH it behaves as before.

  Three things keep that race honest:

  - **The listener is best-effort.** Binding fails when the port is held or the
    sandbox forbids `listen()` — precisely the conditions `--paste` exists to
    serve — so a failure falls back to the prompt rather than ending the login
    before the URL is printed.
  - **Only the prompt's _success_ competes.** A blank line or a mistyped paste
    rejects that half; letting a rejection win would tear down a server about to
    receive a perfectly good callback, burning the authorization code.
  - **Only the prompt announces.** Presenting both halves opened the authorize URL
    two or three times, since the loopback receiver honours a caller-supplied
    `openUrl` regardless of its own `openBrowser: false`.

  `manualReceiver` prefers a declared `hostedUri` over synthesising a loopback
  URI, and `promptReceiver` accepts a `signal` so a pending stdin read can be
  abandoned when something else completes the flow.

  **Unknown options are now errors.** `--loopback` parsed, was ignored, and the
  command ran its default — so it looked like a mode selector that did nothing:

  ```
  ✗ Unknown option "--loopback".
    loopback is the default — drop the flag, or use --paste / --device
  ```

  Single-dash long options are caught too. `-device` was exploded into six
  one-character keys, every one skipped by the guard, so the typo silently ran a
  browser login and then waited on a headless box for a callback that could never
  arrive. Clusters still expand when every character is a real short flag.

  **`--paste` on a device-only provider now fails.** The guard existed but sat
  inside receiver selection, which the device-only branch short-circuits past — so
  `login github-copilot --paste` quietly ran a device login instead.

  **Google's device flow is gone.** The endpoint exists but accepts only a client
  registered as "TVs and Limited Input devices", and a coding CLI is not a
  television; the published gemini-cli client is a Desktop app, refused with
  `invalid_client / Invalid client type`. Providers can still carry a
  `devicePrerequisite`, surfaced when the request fails rather than only alongside
  a code that never arrives.

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
