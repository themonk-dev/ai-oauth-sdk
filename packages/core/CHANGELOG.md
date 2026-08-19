# @ai-oauth-sdk/core

## 1.2.0

### Minor Changes

- 8b51237: Bind deep-link callbacks to the attempt that started them, and stop replaying the launch URL.

  A custom URL scheme is not a private channel. Any other app on the device, and any web page the user follows a link from, can send `myapp://auth/callback?...` into the receiver, and it settled the login from anything whose path matched the redirect URI. A single unsolicited `?error=access_denied` therefore cancelled a sign-in on demand — the client's own `state` comparison only guards the success path, so a `wait()` that rejects is a failed login whatever the callback was. The loopback receiver is bound to its attempt the same way, in this release, and additionally turns away the subresource form of the same request using the `Sec-Fetch-*` headers a browser attaches; a custom scheme carries no such headers to judge by, so `state` is the whole of it here.

  The same hole was reachable without anyone sending anything. `wait()` read `getInitialURL()` unconditionally, and that source does not drain: it keeps returning the URL that cold-started the app for the life of the process. A callback bound to nothing was replayed into every later login in that process.

  Callbacks are now matched to the attempt by `state`, read from the authorization URL handed to `present()` so the two cannot drift, and one that disagrees is dropped rather than settling the login. A callback carrying no `state` where one was presented is dropped too: on a custom scheme "not ours" is the default, and RFC 6749 §4.1.2.1 requires `state` to be echoed on error responses as well as successful ones, so nothing legitimate is turned away. A provider that ignores that rule leaves the login pending rather than failing it, which is what `timeoutMs` and `signal` are for. A provider that sends no `state` at all leaves nothing to compare, and its callbacks are still taken as they come. The redirect URI is now compared by whole path rather than by prefix, so `myapp://auth/callbackXYZ` is no longer treated as the callback screen.

  `parseQuery` is exported from core for this: a receiver reading a param back out of an authorization URL needs the same parser the URL was built with, and bare React Native cannot reliably reach for `URLSearchParams` to do it.

  The documented cold-start resume was corrected rather than kept. It could not work and never could: the relaunched app calls `createAuthorization()` again, which mints a fresh `state`, so the URL from before the kill belongs to an attempt that no longer exists. Finishing a flow the OS interrupted means handing the URL to `completeAuthorization({ callbackUrl })` yourself, with storage that survives the restart and within the authorization TTL.

### Patch Changes

- 8b51237: Key the exchanged-credential cache on the token it was derived from, and redact the device flow's `error` code before printing it.

  **`createAuthenticatedFetch()` cached the exchanged credential on nothing at all.** For a provider that declares `exchangeCredential` — GitHub Copilot is the one in the box — the stored OAuth token is not the API credential, so the fetch trades it for a short-lived one and holds that for its ~25-minute life rather than paying a round trip per request. The cache was a closure variable holding the credential and its expiry, and no record of whose it was. It was thrown away on exactly one path: the 401 retry.

  Nothing else can reach it. `logout()` clears the client's in-memory tokens and the storage key, but has no handle on a fetch built from that client, and the fetch never asks whether the token underneath it is the one it exchanged. So a sign-in, one Copilot call, a `logout()`, and a second sign-in on the same `AuthClient` left the second account's requests carrying the first account's credential — and going to the first account's host, because Copilot only learns its API host from the exchange and an enterprise account gets a different one. Requests made by user B went out as `Bearer EX(USER-A)` to A's host, for as long as A's credential remained valid. No 401 ever corrected it, since A's credential was not expired or revoked — merely not B's.

  Reusing one fetch across calls is the documented shape, not misuse: it is presented as a long-lived object to hand to an SDK, and holding one for the process is the point of it. The library never told the caller to rebuild it after a logout, and nothing in the type says it is bound to an account.

  The cache now records the stored access token the credential came from and is only read while that token still matches. A changed token — a different account, or any other reason the stored value moved — misses and re-exchanges, which also picks up the new account's `baseUrl`. Reuse across calls for one unchanging token, the renewal window, and the 401 discard are all unchanged, and there is no public API change.

  **On the device flow, the provider's `error` code was interpolated verbatim** into the failure message and stored on `providerError`, unbounded, while `error_description` and the raw body beside it both went through `safeSnippet`. A gateway that reflects the request into that field — the same misconfiguration the redaction exists for — put a live `device_code` and PKCE `code_verifier` straight into the error message, and from there into logs and terminal scrollback. The identical body handled by the token endpoint's path came out redacted, because `readTokenError` sends `error` through `safeSnippet` like everything else; this was the one call site that did not. It now does, at the throw only: the `authorization_pending` and `slow_down` comparisons that drive the poll loop keep matching the raw value rather than depending on a spec code happening to survive redaction unchanged.

- 8b51237: Serialise `AuthorizationRegistry.consume()` per state, so concurrent callers cannot all be handed the same PKCE verifier.

  `consume()` read the pending record and then deleted it, with two awaits into storage in between and nothing holding the interval. Callers arriving together therefore all completed their read before any of them reached the delete, and all of them were handed the same record — the same authorization `state` and the same `codeVerifier`. Three concurrent `consume()` calls for one state all resolved, against memory storage and against the file storage the CLI uses; two concurrent `completeAuthorization()` calls both reached the token endpoint with byte-identical bodies. Replaying a state _sequentially_ was refused correctly the whole time, which is precisely what made the concurrent case easy to miss.

  The consequence is narrower than a replayed exchange. The verifier never leaves the process, and only one redemption of an authorization code can succeed at the authorization server, so no extra token is minted. What the duplicate buys is the code reuse itself: an authorization server following RFC 6749 §4.1.2 revokes every token it has already issued for a code it sees a second time, so the request that lost the race takes down the session the request that won had just established. It does not take an attacker holding a captured callback to get there — a browser resending a callback on a double submit, or a link scanner prefetching the redirect URI, is enough.

  Calls for one state now queue: a later arrival waits for the one in flight to finish, however it finishes, and then reads again, finding the record gone and reporting it as already used. `consumeLatest()` resolves its pointer and delegates through `consume()`, so it inherits the same guarantee. Expiry, the `state_expired` branch, and the sequential single-use behaviour are unchanged, and there is no public API change.

  This covers in-process concurrency only, and deliberately stops there. `AuthStorage` exposes `get`, `set` and `delete` with no compare-and-swap, so two CLI windows sharing one `auth.json` can still both read the record before either deletes it. Closing that would mean adding an atomic primitive to the storage interface and implementing it in every backend, from a file to `SecureStore` — a much larger change than this defect justifies.

## 1.1.3

### Patch Changes

- e975c27: Refuse a discovery document that was redirected down to cleartext before it was served.

  `providerFromDiscovery()` checks the issuer's scheme before the request, so the document decides the provider's endpoints only if it was asked for over `https`. That constrains where the request was _sent_. It says nothing about where the document was actually _served from_: `fetch` follows redirects by default, and outside a browser there is no mixed-content bar on an `https`→`http` hop — Node's `fetch` follows one.

  So an `https` issuer that redirects to `http` lands back in the case the issuer check exists to prevent. Whoever is on the network path writes the document, names `https` endpoints of their own, and those pass every later check and are carried by the descriptor for its whole life — every subsequent code exchange and refresh POSTs the authorization code, the PKCE verifier, the refresh token and the client secret to a party of their choosing.

  Reaching that state does not require an attacker to do anything clever. They cannot answer the initial `https` request at all without forging TLS, so the redirect has to come from the issuer itself. The realistic way it does is a familiar misconfiguration: an identity server behind a TLS-terminating proxy that ignores `X-Forwarded-Proto` and emits an absolute `Location: http://…` when it canonicalises a host or a trailing slash. The self-healing form of that bug, where the cleartext vhost redirects straight back to `https`, is still exploitable — the attacker simply answers that one cleartext GET themselves.

  The response's final URL must now use `https`, with the same loopback exemption every other check here gives, so a local authorization server on `http://127.0.0.1:<port>` keeps working.

  Deliberately a scheme check and nothing more. Refusing redirects outright, or requiring the final origin to match the issuer, would break issuers that legitimately redirect for path normalisation or onto a separate identity host, and neither hop is the problem. The `http`→`https` upgrade that previously argued against checking here can no longer arise, because an `http` issuer is refused before any request is made.

  The loopback exemption is inherited only when the issuer was itself on loopback. A local development server redirecting within `127.0.0.1` is ordinary; a public `https` issuer redirecting _down_ onto loopback is not, and would hand the choice of endpoints to whatever local process holds that port. A final URL that does not parse is refused rather than waved through, matching what the issuer and endpoint checks already do with one.

  A `FetchLike` that returns a hand-built `Response` reports its `url` as empty, so stubs and test doubles are unaffected.

## 1.1.2

### Patch Changes

- e0f0ee6: Require `https` on the issuer `providerFromDiscovery()` fetches from, except on loopback.

  The previous release required `https` on the endpoints lifted _out of_ a discovery document. It never checked the URL the document was fetched _from_: the issuer was string-concatenated into a `.well-known/openid-configuration` path and handed to `fetch`, so `providerFromDiscovery('http://sso.corp.internal', …)` was accepted without comment.

  That leaves the strictly worse half of the same problem open. The library would reject an `http` `token_endpoint` served by an `https` issuer — a misconfiguration, visible to whoever runs the issuer — while accepting an `https` `token_endpoint` chosen by whoever sits on the network path in front of an `http` issuer. An on-path attacker answering the cleartext discovery request returns a document naming `https://evil.example/authorize` and `https://evil.example/token`; both are `https`, so the endpoint check passes them, and passing is worse than silence here because it reads as validation of values the issuer never sent. The descriptor then carries them for its entire life, and every `exchangeCode()` and `refreshTokens()` POSTs the authorization code, the PKCE `code_verifier` and any `clientSecret` to the attacker.

  The rationale for the endpoint check already rested on this: "an `https` issuer — TLS-verified, and the only thing the integrator actually vouched for". The code simply never enforced the assumption it was reasoning from. It does now, using the same rule and the same `127.0.0.1` / `[::1]` / `localhost` exemption, so local development authorization servers keep working. An issuer that does not parse as a URL is rejected too, with its own message. The check runs before the request rather than after it, because a cleartext discovery request has already announced the client and invited a response by the time any value could be examined.

  An integrator who genuinely has a plaintext internal IDP should describe it with `defineProvider()`, which leaves a hand-written `http` endpoint alone as it always has. Note that passing `authorizationUrl` and `tokenUrl` explicitly is no longer a way to keep a cleartext _issuer_: the check runs before the fetch, and it has to, because the discovery request itself is the part that travels in the clear. Endpoints an integrator typed are still exempt from the endpoint check — that exemption is unchanged — but they no longer excuse the transport.

  Nothing was added around redirects. Refusing them, or comparing the final `response.url` origin to the issuer, breaks issuers that legitimately redirect — an `http`→`https` upgrade, or path normalisation — and a custom `fetchImpl` is free to ignore either signal anyway. Validating the document's own `issuer` claim likewise stays out: with the issuer required to be `https`, that is spec conformance rather than a vulnerability, and it would reject multi-tenant deployments by design.

- e0f0ee6: Bind a pending authorization to the provider that started it

  Pending records are keyed by `state` alone, and one storage is routinely shared
  by every client an app builds. `completeAuthorization()` consumed whatever
  record that key named without ever asking whose it was, so a callback handed to
  the wrong client posted the _other_ flow's code, PKCE verifier and redirect URI
  to this provider's token endpoint, under this provider's client id.

  Mis-routing the callback is an application bug, and the exchange fails — the
  receiving server does not recognise a code it never issued. But it fails after
  the request goes out, so the credential has already left the process, and the
  legitimate flow's record is consumed either way and can no longer complete.
  That is the mix-up class of OAuth 2.0 Security BCP §4.4: the authorization
  response is not bound to the issuer it came from. A hostile or low-trust
  provider on the receiving end gets a live code plus its verifier plus its
  redirect URI for someone else's provider, whose client id is public.

  The easiest way to make the mistake is a single-page app with one shared
  `/callback` route, which has to pick a client before it knows whose `state` it
  is holding. `consumeLatest()` — the path for providers that never echo `state`
  — was provider-scoped from the start; this is the same rule on the
  `state`-keyed path, and the mismatch now throws `state_mismatch`.

  The record stays consumed when the check fails: a callback that reached the
  wrong client should not be replayable at the right one. Ids the provider used
  to have count as its own, so a flow started before a rename — `anthropic` to
  `claude`, `google` to `gemini`, `microsoft` to `azureAi` — still completes
  across the upgrade that renamed it, the same allowance already made for
  credentials stored under a previous key.

## 1.1.1

### Patch Changes

- 3f7b8b5: Require `https` on endpoints `providerFromDiscovery()` takes out of a discovery document, except on loopback.

  `authorization_endpoint`, `token_endpoint` and `device_authorization_endpoint` were lifted from the document and handed to `defineProvider()` unexamined. That is a different trust question from the one `defineProvider()` answers. An `http` URL written into a provider descriptor by hand is something the integrator typed and chose to live with; the same string arriving in a discovery document comes from a remote party, and the only thing the integrator actually vouched for is the issuer's TLS certificate.

  So an `https` issuer naming an `http` `token_endpoint` would have us POST refresh tokens and the client secret in cleartext, for the entire life of the descriptor, with nothing anomalous to notice. The `authorization_endpoint` is also the only remotely-supplied string that reaches the platform browser launcher.

  Endpoints taken from the document must now parse as a URL and use `https`, with `http` allowed on `127.0.0.1`, `[::1]` and `localhost` so local development and test servers keep working. The error names the field and the offending value, because the failure surfaces at construction time, far from whoever serves the discovery endpoint.

  An `authorizationUrl` or `tokenUrl` you pass in yourself is untouched — the check is on where the value came from, not on the value that wins.

  No issuer-equality check was added. Binding `document.issuer` to the requested issuer defends against OAuth mix-up, which needs a client that chooses dynamically among several issuers; an `AuthClient` here is bound to exactly one provider at construction. It would also reject legitimate multi-tenant deployments, where discovery at `.../common/v2.0` returns a tenant-specific issuer by design.

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

## 1.0.2

### Patch Changes

- 074e5a4: Echo `code_challenge_method` on the OpenRouter token exchange. Its key endpoint
  requires the PKCE method on the exchange as well as the authorization request,
  and rejects the exchange with `400 Invalid code_challenge_method` without it.

## 1.0.1

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

### Minor Changes

- 380a105: Added `ProviderId`, a named constant for the built-in ids.

  ```ts
  import {
    createAuthClient,
    ProviderId,
    publicClientIds,
  } from "@ai-oauth-sdk/core";

  createAuthClient({
    provider: ProviderId.GitHubCopilot,
    clientId: publicClientIds[ProviderId.GitHubCopilot],
  });
  ```

  Every value is the plain kebab-case id, so this is a way to autocomplete the string rather than a
  new thing to pass. `provider: 'github-copilot'` keeps working, custom ids are still ordinary
  strings, and nothing accepts an id it did not accept before.

  Azure AI has no entry, because it has no fixed id to name. Its endpoints are tenant-scoped, so the
  descriptor comes from `azureAi({ tenant })`.

### Patch Changes

- 63f7a74: Point every package at the documentation site. Nine of the ten had no `homepage`, so npm showed no
  Homepage link at all, and the tenth pointed back at the repository README. Each now links to its own
  page on the docs site, and every package gets a `bugs` URL so npm shows an Issues link too.

  No code changes. The READMEs were also rewritten for readability.

## 0.3.0

### Minor Changes

- 596450f: Make a GitHub Copilot token usable against the Copilot API.
  `createAuthenticatedFetch` sent the stored `ghu_` GitHub token, which
  `api.githubcopilot.com` rejects: it wants a short-lived Copilot token obtained
  by exchanging the GitHub one, and the same exchange response names the host to
  send it to, which differs between individual and enterprise accounts. So neither
  the credential nor the base URL could be known from the descriptor, and every
  request went out with the wrong one of each.

  A new optional `exchangeCredential` hook on `ProviderConfig` resolves a stored
  token into the `ResolvedCredential` a request actually needs: a token, a base
  URL, headers and an expiry. `createAuthenticatedFetch` calls it, caches the
  result until shortly before it expires, and re-runs it on a 401 rather than
  refreshing the underlying OAuth token, since the exchanged credential is the
  part that goes stale. Providers without the hook are unaffected.

  `exchangeForCopilotToken()` now also returns `apiBaseUrl` when GitHub names one,
  and is still exported for anyone driving requests by hand.

  Two smaller corrections came with it. The `headers` option on
  `createAuthenticatedFetch` now takes precedence over provider-supplied headers,
  so `{ 'Editor-Version': 'my-cli/1.0' }` identifies you as yourself rather than
  losing to the default; a header set on the request itself still wins over both.
  And that merge is now case-insensitive, the way HTTP is.

- 3b6f333: Make an OpenAI token usable for inference. `apiBaseUrl` pointed at
  `https://api.openai.com/v1`, which answers every token this provider mints with
  `403 Missing scopes: api.model.read`. It now points at
  `https://chatgpt.com/backend-api/codex`, the surface a ChatGPT sign-in actually
  opens, and the descriptor supplies the rest of what that endpoint needs: the
  `OpenAI-Beta` and `originator` headers, a `client_version` query parameter, and
  a `/responses` body rewritten for a stateless backend that would otherwise
  answer with an empty stream.

  Two new optional hooks on `ProviderConfig` carry that, and both are honoured by
  `createAuthenticatedFetch`: `apiQuery(tokens)` adds query parameters, and
  `transformRequestBody(url, body, tokens)` rewrites a JSON request body. Bodies
  that are streams, form data or bytes are passed through untouched.

  Also adds `fetchCodexModels(client)`, which lists the model slugs the signed-in
  account can use. The set depends on the user's plan and on `client_version`, so
  it is worth asking rather than hardcoding a slug.

  Pass `baseUrl: 'https://api.openai.com/v1'` to `createAuthenticatedFetch` for an
  API-key account, whose token carries no `https://api.openai.com/auth` claim.

## 0.2.1

## 0.2.0

### Minor Changes

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

### Patch Changes

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
