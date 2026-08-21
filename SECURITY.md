# Security

## Reporting a vulnerability

Report privately rather than in a public issue, through
[GitHub's private vulnerability reporting](https://github.com/themonk-dev/ai-oauth-sdk/security/advisories/new)
for this repository.

Include what you can: the affected version and package, what happens, and ideally a reproduction. We
will acknowledge it and keep you posted on a fix.

## What this library protects, and what it does not

`ai-oauth-sdk` obtains OAuth tokens and hands them to you. Once a token is in your process,
protecting it is your job. The library does not encrypt tokens in memory and cannot stop your
application from logging or transmitting them.

What it does do:

**PKCE is on by default**, with S256, for every redirect-based provider. The verifier is persisted
only for the flow's lifetime, ten minutes by default, and consumed once, so a replayed callback
cannot replay the exchange. Callbacks arriving together for one `state` are serialised, so a browser
double-submit or a prefetched redirect gets one exchange rather than two. That serialisation is per
process: `AuthStorage` has no compare-and-swap, so two processes sharing one credential file can
still both consume the same record.

**Randomness never degrades.** With no `crypto.getRandomValues` available, the library throws rather
than falling back to `Math.random()`. A guessable `state` or PKCE verifier defeats the point of
both. SHA-256 does have a pure JavaScript fallback, because a hash handles no secrets, and that is
what makes PKCE work on Hermes with no native polyfill.

**`state` is verified on every callback, in constant time.** A plain `!==` short-circuits at the
first differing character, which in principle turns a 256-bit guess into an incremental one. The
practical risk is low, since an attacker also needs a usable `code` and the pending record is single
use, but the comparison sits on a security boundary.

**A callback carrying no `state` is rejected.** Anyone can reach a loopback port or post a message to
an opener, so omitting the parameter must not become a way to skip the check. A custom
`CallbackReceiver` has to return the `state` it received.

Providers that never return `state`, which today means OpenRouter, set `echoesState: false` and
resolve against the most recently started flow instead. That is fine for a CLI or a single-flow app.
**It is not safe in a multi-user server**, where one user's callback could complete another's login.

**The loopback server** binds the loopback interface, never `0.0.0.0`, answers `GET` and `HEAD`
only, and closes itself the moment a callback settles, so it really does serve exactly one. It sends `no-store`,
`no-referrer` and `nosniff`, because the callback URL carries the authorization code in its query
string. It also turns away anything the browser itself labels as other than a top-level navigation —
`Sec-Fetch-Site` present and not `none`, without both `Sec-Fetch-Mode: navigate` and
`Sec-Fetch-Dest: document`. Any page the user happens to have open can aim an `<img>` at a loopback
port, and two of the bundled providers bind published, fixed ones. Such a request cannot read the
response or produce a matching `state`, but a bare `?error=access_denied` would otherwise cancel
whichever login was in progress, so it is refused without touching the pending callback and the real
redirect still completes. The destination is checked as well as the mode because a hidden
cross-origin `<iframe>` is also a navigation, and `127.0.0.1` is a potentially trustworthy origin, so
mixed content does not stop an https page embedding one. A client that sends no `Sec-Fetch-*`
headers at all, which means anything that is not a browser, is unaffected.

That check cannot be the whole answer, because the provider's own redirect is a cross-site top-level
navigation too and is indistinguishable from a page navigating the user to the same URL. So the
callback is also matched to the attempt by `state`, read from the authorization URL the receiver was
handed: one that disagrees, or that carries no `state` where a state was presented, is refused
without settling the pending callback and the server keeps listening for the real one. A provider
declaring `echoesState: false` has said no `state` will come back and is exempt, and a receiver
driven directly, without `present()`, has no attempt to compare against and takes callbacks as they
come.

**It binds every address the redirect URI's host resolves to**, which is not the same thing as
binding one. Most providers register the `localhost` form of the redirect URI rather than the IP
literal, and on a dual-stack machine `localhost` is both `127.0.0.1` and `::1` — with browsers
trying `::1` first. Binding only `127.0.0.1` would leave `[::1]:<port>` free for any other local
user to take, and they would receive the callback while our own bind succeeded and the login looked
normal, because a port is reserved per address and not per name. So the sibling address is bound
too. A port already held there is treated as the hazard it is: on a fixed, published port the login
is refused rather than started, and on an ephemeral one the receiver moves to a different port. A
host with IPv6 switched off cannot resolve `localhost` to `::1` either, so binding IPv4 alone is
complete there and the receiver degrades quietly.

What that protects is narrower than it looks, and worth being plain about. PKCE is what stops a
captured code being redeemed, since the verifier never leaves this process — so a squatter who won
the race would get the code, the ability to stall the login, and control of a page on a URL the user
was told to trust, but not a token. That depends on the authorization server actually enforcing the
challenge, which this library cannot observe, and it does not apply at all to a provider you define
with `usePkce: false`.

**Popup callbacks are origin-checked** before being trusted, and `postCallbackToOpener` posts to its
own origin rather than to `*`.

**`announceCallback` broadcasts on your own origin, to everything listening on it.** A
`BroadcastChannel` cannot be opened from another origin, so the code does not leave yours — but it
does not reach one window the way `postMessage` does. Every same-origin context is in the audience,
your other tabs and your own iframes included. `popupReceiver` compares `state` and ignores a
callback minted for a different attempt, and the client compares it again before exchanging, so a
callback taken by the wrong tab fails rather than completing. A callback carrying no `state` where
the attempt presented one is ignored on the same test, and that direction is the one that bites: the
redirect page announces whatever query string it was loaded with, so a cross-origin link to
`?error=access_denied` on that page — or a second tab of an app whose root *is* its redirect page —
puts a state-less denial on the channel, and taking one would cancel a live sign-in outright. The
receiver rejects before the client's own comparison can run, so this is the only place it can be
caught. A provider declaring `echoesState: false` is exempt, because it has said the callback will
not carry one; that is the same narrow exemption, with the same caveat, described above. Use it on
redirect pages that need it — an authorization page that severs `window.opener` leaves no
alternative — and prefer `postCallbackToOpener` wherever the opener survived.

**Discovery is treated as remote input, over a transport that has to stay https.**
`providerFromDiscovery()` takes a document from a party you have not vouched for, and that document
names the endpoints every later code exchange and refresh will post to — so the issuer must use
`https`, the endpoints it names must use `https`, and the URL the document was finally *served* from
must use `https` too. The last of those is not the same check as the first: `fetch` follows
redirects, and outside a browser nothing bars an `https`→`http` hop, so an issuer that redirects
down to cleartext would otherwise let whoever is on the path write the document and choose
endpoints that pass every remaining check. Loopback is exempt throughout, so a local authorization
server on `http://127.0.0.1:<port>` still works. Endpoints you pass explicitly are your own config
and are left alone — all of them, including `deviceAuthorizationUrl`, which the document used to
override no matter what you pinned. Pinning it back is worth doing: the device endpoint chooses the
`user_code` and `verification_uri` a CLI then reads out to the user verbatim, which is a
device-code relay handed to whoever wrote the document. There is no issuer-equality check, which
would break legitimate multi-tenant deployments; an `AuthClient` is bound to one provider at
construction, so it has nothing to be mixed up with.

**A provider id a built-in has shed is a name, not an identity.** Three built-ins were renamed —
`claude` was `anthropic`, `gemini` was `google`, `azureAi` was `microsoft` — and each still honours
its old id, so a credential stored under it is adopted and a flow started under it can still be
completed. Nothing about a name says who issued what sits under it, and the ids the built-ins let go
of are free for anything to claim: a descriptor of your own, or, before this was fixed, one command
of the shipped CLI. So a record found under a previous id now has to agree on the token endpoint as
well. Records that name no endpoint — everything written before the field existed, which is exactly
the version the rename migrates from — are still accepted, so upgrading does not sign anyone out.
The current id is matched on the name alone: that key is the client's own, and pointing a provider
at your own staging endpoint is a supported thing to do. Every id the built-ins answer to, current
and shed, is exported as `reservedProviderIds`; the CLI refuses all of them for
`--authorize-url`/`--token-url`, and it is worth consulting before you name a provider of your own.

**Errors never carry a credential.** A failed token request quotes a snippet of the provider's
response, which is genuinely useful for diagnosis, but that body is not ours and a misconfigured
gateway echoing the request back would put a live refresh token straight into your logs. Snippets
pass through `redactSecrets()` first. Treat that as defence in depth rather than a guarantee: it
scrubs the OAuth parameters and the token shapes the supported providers issue, not arbitrary
secrets.

OpenAI's device flow gets one extra step, because its `device_auth_id` and `user_code` are not
identifiers: posted back as a pair they return an authorization code *and* the PKCE verifier that
redeems it, so between them they are the whole approval credential. Name-based redaction is not
enough for a value a provider mentions in prose rather than as a parameter, so a failed poll scrubs
those two values out of the snippet by value before quoting it. That works only because they are
this process's own codes — it does nothing for a credential the library never held.

**`logout()` beats a refresh that is already on the wire.** Clearing the local record is
synchronous, but a token request dispatched a moment earlier cannot be recalled, and a provider that
rotates answers it with a new access *and* refresh token one round trip later — which, written back,
would restore the session in memory and on disk, where the next process reads it as an ordinary
sign-in. So a refresh is bound to the sign-out generation it started in: one that returns after a
`logout()` writes nothing and rejects with `aborted` rather than handing back a credential the
client has disowned, and a call arriving after the sign-out starts fresh instead of joining it.
`logout()` itself still never waits for the network and still clears local state either way. This
does not reach across processes: another process refreshing the same stored credential has its own
client and its own sign-out state, and `AuthStorage` has no compare-and-swap to coordinate them.

**`TokenSet.raw` holds a second copy of every credential**, because it is the token endpoint's
response verbatim. Do not log it or ship it to telemetry. The named fields are what you want.

**JWTs are decoded, never signature-verified.** They arrive over TLS directly from the token endpoint
and are read only for convenience fields. Do not pass a third-party token to `decodeJwtPayload` and
treat the result as authenticated.

## Token storage

Pluggable, and defaults to memory.

| Adapter | Protection |
|---|---|
| `fileStorage()`, Node | `0600`, atomic temp-file rename |
| `sessionStorageAdapter()`, browser default | Survives the redirect, not the tab |
| `localStorageAdapter()`, browser | Readable by any script on the origin |
| `secureStoreAdapter()`, Expo | Keychain, EncryptedSharedPreferences |
| `asyncStorageAdapter()`, React Native | **Not encrypted at rest** |

`fileStorage()` creates its directory `0700` and writes the temp file with `O_EXCL`, so a symlink
planted at the temp path is refused rather than followed. It cannot do more than that. A directory
that already exists keeps the permissions it already had, so if you point `dir` at a location other
local users can write to, they can still replace the credential file itself. Keep the credential
directory owned by, and writable only by, the user running the CLI. An empty `dir`, or an empty
`AI_OAUTH_SDK_HOME`, is read as unset and falls back to `~/.ai-oauth-sdk` rather than being treated
as a directory: joining an empty directory with the file name yields the relative path `auth.json`,
which would put the credential file wherever the process happened to start — in CI, the checked-out
repository. The file would still be `0600`, so that was a credential written somewhere nobody chose
rather than one exposed to other local users; the cost is that it outlives the job in a git tree or
a build artifact, and that the path the CLI reported back does not exist to go and delete.

Prefer `secureStoreAdapter` for refresh tokens on mobile. In a browser, any XSS on your origin can
read whatever web storage you chose. On a server, encrypt at rest.

`localStorageAdapter()` and `sessionStorageAdapter()` fall back to memory where the browser throws
on access — Safari private mode, a sandboxed iframe — and in a browser Web Worker, which has no web
storage but is still one user's browser. Off a browser they refuse instead, because an in-memory
store on a server is a single `Map` shared by every request it serves. Cloudflare Workers and other
workerd-based runtimes count as servers here, not as browsers. Their global exposes
`WorkerGlobalScope`, but one isolate serves many users' requests, so an in-memory store there is a
single `Map` holding every one of their tokens. `localStorageAdapter()` and
`sessionStorageAdapter()` refuse on any runtime they cannot positively identify as a browser Web
Worker; supply `storage:` explicitly if you are on one they do not recognise.

## Client credentials

The client ids shipped for OpenAI, Anthropic, GitHub Copilot, Qwen, Google and xAI are public,
PKCE-protected values published by those vendors' own CLIs. They are not secrets. One client secret
is embedded, Google's, because its token endpoint refuses an installed-app exchange without one and
Google documents those secrets as non-confidential. Everything is overridable.

Using a vendor's CLI client id means presenting yourself as that CLI. Review the provider's terms
before shipping it, and read the
[disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer), which covers what this project is
and is not in relation to those vendors.

**The CLI never persists a client secret.** It reads one from `--client-secret` or
`AI_OAUTH_SDK_CLIENT_SECRET` per invocation and keeps it out of the credential file, so a value that
was briefly visible in `ps` does not become a durable copy on disk. Prefer the environment variable,
since a flag lands in shell history too.

## Supply chain

Every package is published from CI with `provenance: true`, producing a signed attestation that
links the tarball to the commit and workflow that built it. Verify it with `npm audit signatures`.

The release pipeline is split on purpose. The half that installs dependencies and runs the build
holds no credentials and no cache, and hands over a directory of tarballs. The half that can mint an
npm credential installs nothing and runs no project code. Trusted publishing does not remove the
credential, it makes it mintable on demand, so any code running in a job holding `id-token: write`
can mint one.

## Supported versions

Before 1.0, fixes land on the latest minor. Once 1.0 ships, the current major receives security
fixes.

Runtime support tracks Node's own calendar. The packages declare `engines: >=22` and CI covers Node
22, 24 and 26. Node 18 and 20 are past end of life and are no longer tested. The code depends on
nothing newer, so they will very likely still work, but do not rely on it for anything you care
about.

The full version of this page, with examples, is at
[ai-oauth.themonk.dev/resources/security](https://ai-oauth.themonk.dev/docs/resources/security).
