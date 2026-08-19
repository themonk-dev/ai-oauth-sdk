# @ai-oauth-sdk/node

## 1.2.0

### Patch Changes

- 8b51237: Propagate the loopback receiver's refusal through `hybridReceiver()`, so `--paste` is not a way around a squatted port.

  `loopbackReceiver()` refuses to start when the address it is about to advertise is already held — a fixed published port taken outright, or the sibling address that a name like `localhost` also resolves to. `hybridReceiver()` started that receiver inside a bare `catch` and dropped it on any failure, on the reasoning that a port that cannot be bound is one of the conditions `--paste` exists for. That reasoning predates the refusal: the sibling case was added later, and the comment was never revisited.

  Discarding the loopback half does not leave the login without a redirect URI. `manualReceiver()` synthesises one from the provider, which for a loopback provider with a declared port is exactly the URI that just failed to bind. So a local unprivileged process holding `127.0.0.1:56121` (`xai`) or `[::1]:1455` (`openai`) turned a refusal back into a login: the CLI routes every provider without a hosted callback page through this receiver under `--paste`, printed an authorization URL naming the squatter's socket, and waited at the paste prompt while the browser delivered the code to them and they served whatever page they liked on a URL the user had just been told to trust. As elsewhere, PKCE is what keeps the captured code from being redeemed — the verifier never leaves the victim's process — so this is disclosure, interception and a stalled login rather than token theft, and it is not even that for a descriptor built with `usePkce: false`.

  The two failures are now told apart by type: a refusal is an `OAuthError` and is rethrown, and anything else — the EPERM/EACCES/ENOTSUP a sandbox that forbids `listen()` reports — still degrades to the prompt alone. That is deliberately coarser than matching a specific error code, which would be public surface: `start()` throws an `OAuthError` only when it has decided the login should not proceed, and any later reason it decides that propagates without this needing to be revisited again.

  `hybridReceiver().start()` therefore gains a rejection case, and `ai-oauth-sdk login <provider> --paste` on a provider with a fixed port now reports the contested port instead of prompting. The sandbox fallback, the race semantics, and providers that paste against a hosted page are unchanged.

- 8b51237: Bind loopback callbacks to the attempt that started them, in `loopbackReceiver()` and through `hybridReceiver()`.

  The loopback server decided whether a request could settle the pending callback from the `Sec-Fetch-*` headers alone, and never compared `state`. A cross-site _top-level navigation_ passes that gate by design, because the provider's real redirect is one. So any web page the user happened to visit could settle the callback — no click, no local code, nothing to notice — by navigating them to `http://127.0.0.1:1455/callback?error=access_denied`. `openai` publishes port 1455 and `xai` 56121, so there was nothing to guess.

  No tightening of the fetch-metadata check could have closed this. The genuine redirect and the drive-by are byte-identical: `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`. `Sec-Fetch-User` is not a discriminator either — a provider that auto-approves an already-consented app redirects without a user gesture and sends none. Only `state` separates them, and the client's own comparison is too late: it guards the success path, so a `wait()` that rejects is a failed login whatever the callback was.

  What that bought an attacker is denial, not a token. `completeAuthorization()` throws `state_mismatch` on a foreign `code`, and the one bundled provider that does not echo `state` uses PKCE on an ephemeral port. The damage is that settling closes the server, so the real redirect that follows a second later hits `ECONNREFUSED` and the sign-in is lost — repeatably, and for whichever login the page happens to catch.

  Callbacks are now matched to the attempt by `state`, read from the authorization URL handed to `present()` so the receiver's idea of its attempt cannot drift from what it actually sent the user to, and compared with `timingSafeEqual` because it is now on a security boundary. One that disagrees — or that carries no `state` where a state was presented — gets a `403` and the server keeps listening for the real redirect. The `Sec-Fetch-*` check stays, and stays first: it is the only cover for the window between `start()` and `present()`, and for the two cases the comparison deliberately exempts.

  `hybridReceiver()` now presents its loopback half as well as its prompt. Without that the half never learned the `state` and the fix was silently inert under `--paste` — the same fixed ports, the same drive-by. Presenting it is also what opens a browser, so every announcing channel is removed from that half first: `openBrowser` was already forced off, `onAuthorizationUrl` is stripped, and it is started on a context with no `openUrl`. The prompt keeps all three, so the URL is printed once and a browser opened at most once. Stripping `onAuthorizationUrl` there changes nothing today, since the half was never presented before.

  The accepted cost is the same trade-off this release already took in the deep-link receiver. A provider that omits `state` on an error response — which RFC 6749 §4.1.2.1 requires it to echo — now leaves the login pending until `timeoutMs` or the `signal` fires, instead of failing fast. Two exemptions are deliberate: a provider declaring `echoesState: false` has said no `state` will come back, and a receiver driven directly through `start()` without `present()` has no attempt to compare against and still takes callbacks as they come. Unlike a deep-link scheme, a bound port does not exist before the flow does, so there is no pre-existing route for a stray callback to have arrived on — and requiring `present()` would break every caller that drives `start()` itself.

- Updated dependencies [8b51237]
- Updated dependencies [8b51237]
- Updated dependencies [8b51237]
  - @ai-oauth-sdk/core@1.2.0

## 1.1.3

### Patch Changes

- e975c27: Bind every address the advertised loopback host resolves to, so the port cannot be squatted underneath the name.

  `loopbackReceiver()` binds `127.0.0.1`. The redirect URI it hands the authorization server names `localhost`, which is what four of the five bundled loopback providers advertise — `defineProvider()` defaults `loopbackHost` to `'localhost'`, and only `xai` overrides it with the IP literal.

  On a dual-stack machine `localhost` also resolves to `::1`, and browsers try `::1` first: Chromium's resolver returns the IPv6 literal ahead of the IPv4 one, and Happy Eyeballs gives it a head start of a few hundred milliseconds. So another local unprivileged process can bind `[::1]:<port>` and receive the callback while our own bind on `127.0.0.1` still succeeds. Port reservation is per address rather than per name, so the `EADDRINUSE` guard never sees it, and the login looks entirely normal — with no attacker present the browser simply fails over to `127.0.0.1` after ~300ms and everything works, which is why this stayed latent.

  What the squatter gets is the authorization code and `state`, the ability to stall or silently kill any login, and control of the HTML on a URL the user was just told to trust. PKCE is what stops the code being redeemed — the verifier never leaves the victim's process — so this is disclosure and interception rather than token theft, for as long as the authorization server actually enforces the challenge. That is a control this library depends on and cannot observe, and it is absent entirely for any descriptor built with `usePkce: false`. `openai` is the sharpest case: a fixed, published port, so nothing has to be guessed.

  RFC 8252 §7.3 recommends the IP literal precisely to avoid this, but OpenAI registered the `localhost` form of the redirect URI, so the fix cannot be to stop using the name — it has to be to own it. The receiver now binds the sibling address as well, and nothing about what is sent to the authorization server changes.

  Failing to bind the sibling is only treated as an error when something is _holding_ it. A host with IPv6 disabled cannot resolve `localhost` to `::1` either, so there is nothing there to take and the IPv4 bind is already complete; `EAFNOSUPPORT` and friends degrade silently. `EADDRINUSE` is the attack signal: on a fixed published port there is nowhere else to go, so the login is refused with an explanation rather than started, and on an ephemeral port — where a collision is as likely to be ordinary as hostile — the receiver takes a different port instead.

  A provider that already advertises an IP literal, like `xai`, is untouched: nothing else can answer for an address, so there is no sibling to cover. A `host` passed as a name rather than an address is normalised first, so `loopbackReceiver({ host: 'localhost' })` cannot quietly opt back out of the pairing.

  A refusal releases the port it had already taken. That matters more than it sounds: the throw leaves `start()` before the caller holds a receiver, so nothing else can close it, and a listening handle left behind would stop the CLI exiting at all — `bin.ts` sets `process.exitCode` rather than calling `process.exit`. It would also make the next attempt collide with our own socket and report "already in use" instead of the reason the first one was refused.

- Updated dependencies [e975c27]
  - @ai-oauth-sdk/core@1.1.3

## 1.1.2

### Patch Changes

- e0f0ee6: Refuse callbacks a browser marks as a subresource, and close the loopback server once it has served one.

  `loopbackReceiver()` accepted any `GET` that reached the callback path. A `GET` at a loopback port is a _simple request_, so it needs no preflight and no cooperation from us: `new Image().src = 'http://127.0.0.1:1455/auth/callback?error=access_denied'` on any page the user happens to have open lands in the handler, `readCallback()` throws, and the pending login rejects with `authorization_denied`. Two of the bundled providers bind a published, fixed port — OpenAI on 1455 and xAI on 56121 — so the attacker does not even have to guess. A page firing that on a timer breaks every sign-in attempted while the tab is open.

  Nothing is disclosed by it. The response is opaque to the page, PKCE holds, and the `state` check means a forged _success_ is not on the table. What was on the table is denial of login: an arbitrary website reaching into a local process and cancelling something the user started, with the CLI reporting a provider denial that never happened.

  The handler now reads the browser's own account of where the request came from. When `Sec-Fetch-Site` is present and is not `none`, the request is answered `403` and the callback promise is left alone unless it is a top-level navigation — `Sec-Fetch-Mode: navigate` _and_ `Sec-Fetch-Dest: document`, which is what the genuine redirect arrives as. So the drive-by is a no-op and the real callback still completes. The headers are trusted only when the browser supplies them: `curl`, `undici` and any other non-browser caller send no `Sec-Fetch-Site` and are unaffected, and `none` is a URL typed into the address bar, which is legitimate.

  Checking the destination as well as the mode is what closes the vector rather than narrowing it. A hidden cross-origin `<iframe>` is a navigation too, so a mode-only rule lets one through, and `http://127.0.0.1` is a potentially trustworthy origin — mixed-content blocking does not stop an `https` page from embedding it. That is the same cancel-any-login-in-progress attack as the `<img>`, with nothing for the user to see. Only `document` is a redirect back from the provider; `iframe`, `frame`, `object` and `embed` are not.

  No `Host` or `Origin` check was added, because neither one stops this. A cross-site `<img>` `GET` carries a perfectly valid `Host: 127.0.0.1:1455` and, being a no-CORS navigation-shaped fetch, no `Origin` at all — so both checks pass while the attack proceeds, and requiring an `Origin` would instead reject the real redirect.

  The receiver also now closes itself as soon as a callback settles, guarded so a second request in flight cannot settle it twice. `SECURITY.md` already claimed it "serves exactly one callback before shutting down"; that was true of `login()`, which closes in a `finally`, but not of the receiver, which went on answering for the rest of the flow and would answer a second callback with a `200`. Closing waits for the response to flush, since closing destroys the sockets and would otherwise truncate the page in front of the user, and the caller's later `close()` stays safe — `server.close()` on an already-closed server invokes its callback rather than hanging.

- Updated dependencies [e0f0ee6]
- Updated dependencies [e0f0ee6]
  - @ai-oauth-sdk/core@1.1.2

## 1.1.1

### Patch Changes

- 3f7b8b5: Refuse a symlink planted at `fileStorage()`'s temporary path, instead of writing every provider's tokens through it.

  The temporary file was named `auth.json.<pid>.tmp` and opened with the default `w` flag. Neither half was safe on its own. The name is fully predictable — `pid_max` is small and `/proc` removes even the guessing — and a `w` open follows a symlink already sitting at that path. Anyone who could write to the credential directory could point that name at a file they owned and receive the entire record: every provider's access _and_ refresh tokens, in one write.

  `mode: 0o600` did not prevent it. The mode applies only when `open(2)` actually creates the inode, so an attacker who pre-created the target kept their own permissions on it, and the `chmod` that follows the rename fails `EPERM` on a file we do not own — a failure that was already being swallowed.

  The write now passes `wx` (`O_CREAT|O_EXCL`), which refuses to follow a trailing symlink, and the name carries eight random bytes instead of the pid. The random name is not decoration: with `O_EXCL` and a predictable name, one stale temporary file — left behind by a crash, under a pid the system has since recycled — would turn every later write into an `EEXIST` and wedge the credential store permanently.

  This is a hardening fix, not a break in the default configuration: `~/.ai-oauth-sdk` is created `0700` and is not writable by other users. It matters when `dir`, `--auth-dir` or `AI_OAUTH_SDK_HOME` points somewhere shared — a group-writable team cache, a container bind mount — and Linux's `fs.protected_symlinks` does not help there, since it only covers world-writable _sticky_ directories.

  `fileStorage()` still cannot defend a credential directory other local users can write to, because a directory that already exists keeps the permissions it already had. `SECURITY.md` now says so rather than implying otherwise.

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

## 0.3.0

### Patch Changes

- Updated dependencies [596450f]
- Updated dependencies [3b6f333]
  - @ai-oauth-sdk/core@0.3.0

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
