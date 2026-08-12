# @ai-oauth-sdk/browser

## 1.1.1

### Patch Changes

- Updated dependencies [3f7b8b5]
  - @ai-oauth-sdk/core@1.1.1

## 1.1.0

### Minor Changes

- a13a33d: Fix popup sign-in against providers whose authorization page severs the opener, which today fails Claude on every attempt.

  `claude.ai` serves its authorization page with an enforced `Cross-Origin-Opener-Policy: same-origin` — not the `-report-only` variant `accounts.google.com` sends, which severs nothing. The browser therefore moves the popup into its own browsing-context group: `window.opener` inside it becomes `null` permanently, including after it navigates back to your own redirect page, and your handle to the popup reports `closed === true` while the popup is still on screen.

  `popupReceiver` polled `closed` to notice a user giving up, so it failed a perfectly good sign-in about a second after the popup opened, reporting "The sign-in window was closed before completing" when nothing had been closed and nothing cancelled.

  `popupReceiver` now reads the new `authPage.seversOpener` fact on the provider descriptor and skips that poll for such a provider. Where the opener stays intact the poll still runs, because there it is the only signal a closed window leaves behind. It also listens on a `BroadcastChannel` alongside `postMessage`, which does not go through the opener relationship at all and so survives the swap.

  Redirect pages should fall back to the new `announceCallback()` when `postCallbackToOpener()` reports no opener:

  ```html
  <script type="module">
    import {
      postCallbackToOpener,
      announceCallback,
    } from "@ai-oauth-sdk/browser";
    if (!postCallbackToOpener()) {
      await announceCallback();
    }
  </script>
  ```

  `announceCallback()` resolves `true` once a waiting receiver acknowledges, and closes its own window on the way, because your handle to a severed popup may not be able to. It resolves `false` once the timeout passes with nothing acknowledging, which usually means nobody was waiting — someone opened the redirect URL directly — though a receiver on a busy main thread can miss the deadline for a callback it goes on to accept. `postCallbackToOpener()` is unchanged in both signature and behaviour.

  A callback heard on the channel is matched to the attempt that presented it by comparing `state`, read through the provider's own `parseCallback` so the receiver and the client always agree on what the `state` is. A `BroadcastChannel` reaches _every_ context on the origin, where `postMessage` reaches only the opener: every receiver hears every broadcast, so without the comparison two tabs of the same app signing in at once would each take the other's callback. The `postMessage` path is unfiltered, as it was — a message that arrives there was minted for the window it arrived at.

  A provider that does not echo `state` (OpenRouter) leaves nothing to compare, so two tabs signing in against one of those at the same time can still collide. Nor is there any way to notice a user closing the popup where the opener was severed: pass `timeoutMs` to `login()` for such a provider, or the promise waits as long as the page lives.

  `ProviderConfig.authPage.seversOpener` and `RedirectSpec.acceptsHttpsRedirect` are new optional descriptor fields. Both are additive; existing providers and any `defineProvider()` call keep working untouched, and nothing in the CLI or Node paths behaves differently.

- 7c6d33b: Add `resolveBrowserFlow()`, `autoReceiver()` and `autoLogin()`, so a browser app stops having to work out which sign-in flow a provider will accept.

  Which flow works is a function of the provider's registered client and the origin the page is served from, and until now nothing exposed that. Consumers discovered it by failing: OpenAI's browser sign-in can only ever be the device grant, because its redirect is registered on a fixed loopback port no web origin can present. Claude and Gemini both get a popup on `http://localhost:PORT` — where the page _is_ a valid loopback redirect for a client registered with `loopbackPort: 0` — and both must fall back to pasting once deployed, because neither published CLI client will complete a grant against an HTTPS redirect. None of that was discoverable, so apps hardcoded a table and kept it true by hand.

  `resolveBrowserFlow(provider, origin)` answers it as a pure function, deriving almost everything from fields the descriptors already carried — `loopbackPort`, `loopbackHost`, `hostedUri`, `deviceFlow` — plus the new `acceptsHttpsRedirect`. Providers built with `defineProvider()` are resolved by the same rule, so this is not a hardcoded table of the built-in seven.

  It returns a discriminated union: `popup` with the redirect URI this origin can offer, `device` with the provider's `devicePrerequisite` when it declares one, or `paste` with a typed hint saying whether the code appears on a provider-hosted page or only in the address bar of a redirect that failed to load. The `devicePrerequisite` is worth surfacing: OpenAI's is a setting the user must switch on first, and a UI that hides it produces a code that can never be approved.

  `autoReceiver()` is a `CallbackReceiver` that resolves the flow and delegates to `popupReceiver` or `manualReceiver`. It is opt-in — `login()` and `createBrowserAuthClient()` keep the receiver you chose. For a provider that resolves to `device` it fails immediately, naming `deviceLogin()`, rather than opening a popup onto a page with no code on it: a receiver cannot become a different entry point on the client.

  `autoLogin(client, options)` is the layer that avoids that trap. It resolves the flow once and calls `login()` or `deviceLogin()` accordingly, returning a `TokenSet` either way. Pass `onCode` to receive the user code and verification URL; it is required exactly when the resolution is `device`, and the error says so before anything is started.

### Patch Changes

- a13a33d: Stop `localStorageAdapter()` and `sessionStorageAdapter()` silently becoming a token store shared between users on the server.

  Both adapters treated "storage is unavailable" as one case. It is two. Safari private mode and sandboxed iframes _throw_ on access, and degrading those to an in-memory store is right — a sign-in should not crash there. But on a server the globals are simply absent, `typeof` comes back `'undefined'` with no exception, and the same branch handed back `memoryStorage()`: a plain `Map`, scoped to the module rather than the request, shared by every request the process serves.

  This package is imported from `"use client"` files, and frameworks evaluate those during server-side rendering. An audit of a real app found that store already constructed on the server, empty only because every call site happened to sit inside an effect. Moving one into a render body would have pooled every user's tokens into one `Map`, with nothing warning anybody.

  A Web Worker looks the same from the outside — no web storage, no `window` — and gets the in-memory store rather than the refusal, since nothing in a worker is shared between users. The adapters tell the two apart by `WorkerGlobalScope`, which exists only inside one.

  Constructing an adapter without browser storage is still harmless, because `createBrowserAuthClient()` and `useAuth({ storage: sessionStorageAdapter() })` are called from render bodies that SSR runs, and throwing there would break server rendering for an app that merely imports the SDK. Reading or writing through one now rejects with an error naming the risk.

  **This is a behaviour change** for any code that reads or writes tokens _during_ a server render, which previously succeeded silently against the shared map and now fails loudly. That is the point of the change, but it is the one thing that could surprise an existing consumer. If an in-memory store on the server is genuinely what you want, ask for it explicitly with `memoryStorage()` from `@ai-oauth-sdk/core`.

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
