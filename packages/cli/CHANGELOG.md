# @ai-oauth-sdk/cli

## 1.1.1

### Patch Changes

- Updated dependencies [3f7b8b5]
- Updated dependencies [3f7b8b5]
  - @ai-oauth-sdk/core@1.1.1
  - @ai-oauth-sdk/node@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [a13a33d]
  - @ai-oauth-sdk/core@1.1.0
  - @ai-oauth-sdk/node@1.1.0

## 1.0.2

### Patch Changes

- Updated dependencies [074e5a4]
  - @ai-oauth-sdk/core@1.0.2
  - @ai-oauth-sdk/node@1.0.2

## 1.0.1

### Patch Changes

- feb2453: Fixed `-v` and `--version`, which printed the help text instead of the version.

  The help branch matched on "no command" and ran first, so it swallowed every
  invocation that was only a flag. `ai-oauth-sdk version` worked, and so did
  `ai-oauth-sdk login --version`, but the spelling most people reach for did not.

  The same ordering hid unknown options given without a command:
  `ai-oauth-sdk --typo` printed help and exited 0, which is a success code for a
  mistake. It now reports the unknown option and exits 1. An unknown command is
  still reported ahead of an unknown option, since the command is what decides
  which options are known.

  `version`, `help`, `-v`, `-h` and the `ls` alias are now listed in the help
  text, and its multi-account example no longer uses a provider id that was
  renamed in 1.0.0.

  - @ai-oauth-sdk/core@1.0.1
  - @ai-oauth-sdk/node@1.0.1

## 1.0.0

### Major Changes

- 380a105: **Breaking.** Providers are named after the product, not the company. Anthropic, Google and
  Microsoft are companies; Claude, Gemini and Azure AI are what you sign in to.

  | Was                          | Is                           |
  | ---------------------------- | ---------------------------- |
  | `provider: 'anthropic'`      | `provider: 'claude'`         |
  | `provider: 'google'`         | `provider: 'gemini'`         |
  | `provider: 'microsoft'`      | `provider: 'azure-ai'`       |
  | `anthropic`                  | `claude`                     |
  | `google`                     | `gemini`                     |
  | `microsoft()`                | `azureAi()`                  |
  | `MicrosoftProviderOptions`   | `AzureAiProviderOptions`     |
  | `publicClientIds.anthropic`  | `publicClientIds.claude`     |
  | `publicClientIds.google`     | `publicClientIds.gemini`     |
  | `publicClientSecrets.google` | `publicClientSecrets.gemini` |

  Labels change with them, so a CLI prompt now says `Claude`, `Gemini` and `Azure AI` rather than
  `Claude (Anthropic)`, `Gemini (Google)` and `Microsoft (Entra ID)`.

  **Nobody is signed out by this.** Provider ids are the keys stored credentials live under, so the
  rename would ordinarily orphan every saved token. A new `previousIds` field on `ProviderConfig`
  carries the old id, and `AuthClient` reads it as a fallback and moves what it finds to the new key.
  The migration is one-time and silent. It runs per account, so `--account work` sessions come across
  too.

  To upgrade, replace the identifiers above. Nothing about how a token is obtained, refreshed or
  stored changes.

### Patch Changes

- 63f7a74: Point every package at the documentation site. Nine of the ten had no `homepage`, so npm showed no
  Homepage link at all, and the tenth pointed back at the repository README. Each now links to its own
  page on the docs site, and every package gets a `bugs` URL so npm shows an Issues link too.

  No code changes. The READMEs were also rewritten for readability.

- Updated dependencies [63f7a74]
- Updated dependencies [380a105]
- Updated dependencies [380a105]
  - @ai-oauth-sdk/core@1.0.0
  - @ai-oauth-sdk/node@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [596450f]
- Updated dependencies [3b6f333]
  - @ai-oauth-sdk/core@0.3.0
  - @ai-oauth-sdk/node@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [076f8c0]
  - @ai-oauth-sdk/node@0.2.1
  - @ai-oauth-sdk/core@0.2.1

## 0.2.0

### Patch Changes

- 4848812: Add OpenAI's device flow.

  **`openai` can now sign in headlessly.** `codex login --device-auth` has an
  equivalent here: `client.deviceLogin()`, or `ai-oauth-sdk login openai --device`.

  It shares the _shape_ of RFC 8628 and none of the wire format, so it could not
  be a flag on the existing implementation:

  - request and poll bodies are JSON, not form encoding
  - "not approved yet" is HTTP 403 or 404, not `error=authorization_pending`
  - the identifiers are `device_auth_id` + `user_code`, not one `device_code`
  - approval yields an authorization code plus **the PKCE verifier the server
    generated**, which then goes through the ordinary token endpoint against a
    fixed hosted redirect

  `ProviderConfig` gains an optional `deviceFlow`, so a provider that deviates
  supplies its own two steps while every RFC 8628 provider keeps working from
  `deviceAuthorizationUrl` alone. Exported as `openaiDeviceFlow` for anyone
  building on it directly.

  **The CLI's provider table shows both flows**, e.g. `loopback +device`, so the
  headless option is discoverable where people look for it.

  **OpenAI's device flow needs turning on per account** — "Enable device code
  authorization for Codex" under ChatGPT → Settings → Security. Without it the
  verification page refuses the code while the endpoint keeps answering 403, so
  the CLI sat at "Waiting for approval…" for fifteen minutes with no clue why.
  Providers can now declare a `devicePrerequisite`, and the CLI prints it above
  the code rather than leaving the user to discover it in a browser.

  **`--timeout` now says it timed out.** It aborted the flow internally, so the
  CLI reported `aborted`, which reads like the user pressed ctrl-C.

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

- 4848812: Publish a credential for every provider, and narrow Anthropic's scopes.

  **`publicClientIds` gains `google` and `xai`.** Both descriptors previously said
  no public client existed. That was wrong in both cases:

  - xAI ships one with grok-cli, and it is not merely a convenience — xAI rejects
    any client it has not allowlisted (`invalid_client`, "Unknown or disabled
    client") and offers no self-service registration for a desktop CLI, so telling
    users to "supply your own" pointed at a dead end.
  - Google ships one with gemini-cli, together with the installed-app
    `clientSecret` its token endpoint refuses the exchange without. OAuth and
    [Google's own docs](https://developers.google.com/identity/protocols/oauth2/native-app)
    treat installed-app secrets as non-confidential, so it is exported as
    `publicClientSecrets.google` and the CLI falls back to it the same way it
    already falls back to a client id.

  Every built-in provider now has a credential to opt into, and
  [docs/credentials.md](../docs/credentials.md) lists the raw values so the same
  pair can be passed from the SDK, another language, or a config file. Everything
  stays overridable — `clientId`/`clientSecret`, `--client-id`/`--client-secret`,
  or `AI_OAUTH_SDK_CLIENT_SECRET`.

  **Anthropic asks for what chat needs, and no more.** The default was the full set
  Claude Code requests. Three of those are capabilities no caller needs in order to
  send a prompt, and `org:create_api_key` is worse than unnecessary: it turns any
  leaked token into durable organization API keys that outlive the OAuth session.

  The default is now `user:inference user:profile user:sessions:claude_code` — the
  Messages API, the identity `whoami` reads, and the session the grant belongs to.
  `org:create_api_key`, `user:file_upload` and `user:mcp_servers` are opt-in:

  ```ts
  createAuthClient({
    provider: "anthropic",
    clientId: publicClientIds.anthropic,
    scopes: [...anthropic.scopes, "org:create_api_key"],
  });
  ```

  Stored tokens are unaffected — they keep whatever they were granted. Sign in
  again to narrow one.

- 4848812: Report token failures accurately, and never quote a credential doing it.

  **`state` broke every OpenAI login.** It was added to the token request because
  Anthropic accepts it there, but it was sent to every provider — and `state`
  belongs to the authorization request, not the exchange. OpenAI rejects the whole
  call with `Unknown parameter: 'state'`, which failed both the loopback and the
  paste flow, so `login openai` could not complete at all. It is now opt-in via
  `tokenRequest.includeState`, which only Anthropic sets.

  **Token errors are readable again.** RFC 6749 says `error` is a string. OpenAI
  answers with an object — `{"error":{"message":…,"type":…}}` — which the message
  interpolated straight into the string:

  ```
  token_request_failed: Token request to … failed (HTTP 400): [object Object]
  ```

  Nested shapes are unwrapped, and anything unrecognised falls back to a snippet
  of the body. The device path had the identical bug and the identical fix.

  **Every quoted response is redacted first.** `readTokenError` returned `detail`
  and nested `message` verbatim, bypassing the scrubbing that quoted provider text
  is supposed to pass through — a gateway reflecting the request would have put a
  live `refresh_token` into an error message and any log capturing it. The device
  flow's `error_description` had the same hole.

  **A dead gateway fails in seconds, not fifteen minutes.** Device polling
  tolerates a 5xx because it is the provider's infrastructure talking, not a
  verdict on the grant. But a proxy that is simply _down_ answers every poll, and
  retrying to the device code's expiry blocked for the full code lifetime and then
  reported `timeout: Device code expired before the user approved it` — telling
  the user they were too slow to approve when the truth was a 502. Three
  consecutive server errors are tolerated, then the real status is reported.

  **`createAuthenticatedFetch` sends the token it manages.** It used to let an
  `Authorization` header already on the request win. That is reasonable when you
  call it directly, and wrong when the caller is an SDK that sets `Authorization`
  from its own `apiKey` before handing over — the single most likely way this
  function gets used. The Vercel AI SDK does exactly that, and sends the header
  even when `apiKey` is empty or omitted, so the obvious wiring shipped
  `Bearer unused` while the library refreshed the real token and attached it to
  nothing. Verified against `ai` + `@ai-sdk/openai`. Pass
  `respectCallerAuthorization: true` to restore the old behaviour.

- Updated dependencies [4848812]
- Updated dependencies [4848812]
- Updated dependencies [4848812]
- Updated dependencies [4848812]
  - @ai-oauth-sdk/core@0.2.0
  - @ai-oauth-sdk/node@0.2.0

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
