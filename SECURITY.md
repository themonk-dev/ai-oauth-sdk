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
use, but the comparison sits on a security boundary. Every place that compares a `state` uses the
same constant-time comparison: the client, the loopback server, the popup receiver and the deep-link
receiver.

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

A callback that arrives before the attempt is known is **held, not judged**. The port is bound by
`start()` and the `state` is learned in `present()`, with real storage I/O in between, so there was
a window in which any callback reaching a published loopback port was accepted as ours — enough for
a page the user had open to navigate to `?error=access_denied` and kill the login. The request now
waits for whichever comes first, `present()` or the first `wait()`, and is evaluated against what
that establishes. Nothing is refused for being early: a caller that drives `start()` and opens the
browser itself declares its attempt by calling `wait()`, and is held for that moment rather than
turned away. Requests for another path or another method are answered immediately, since neither can
touch the pending callback. A held request is dropped rather than answered if the receiver is closed
or aborted while it waits, and it is given a timeout of its own so that a caller which neither
presents nor waits cannot leave a connection open indefinitely.

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

**`resolveBrowserFlow()` does not require an https origin before using one.** A provider that sets
`acceptsHttpsRedirect` gets a popup flow with your page's own origin as the redirect URI, and that
origin is copied with whatever scheme it already has. Serve the app from a non-loopback cleartext
origin — `http://app.internal`, a LAN development host — and the redirect URI is `http://` too, so
the authorization code comes back in the clear. The name of the flag promises a check that is not
performed. It is left that way deliberately for now, because requiring https would break those
development setups, and the exposure is narrow: only OpenRouter sets the flag today, PKCE covers the
captured code, and anyone on the path of a cleartext origin can already rewrite the page. Serve over
https, or loopback, if the origin is not yours alone.

**Discovery is treated as remote input, over a transport that has to stay https.**
`providerFromDiscovery()` takes a document from a party you have not vouched for, and that document
names the endpoints every later code exchange and refresh will post to — so the issuer must use
`https`, the endpoints it names must use `https`, and the URL the document was finally *served* from
must use `https` too. The last of those is not the same check as the first: `fetch` follows
redirects, and outside a browser nothing bars an `https`→`http` hop, so an issuer that redirects
down to cleartext would otherwise let whoever is on the path write the document and choose
endpoints that pass every remaining check. Loopback is exempt throughout, so a local authorization
server on `http://127.0.0.1:<port>` still works. Endpoints you pass explicitly are your own config
and are left alone. There is no issuer-equality check, which would break legitimate multi-tenant
deployments; an `AuthClient` is bound to one provider at construction, so it has nothing to be
mixed up with.

A document endpoint containing a **control character is refused**, and what is stored is the URL
parser's own normalised form rather than the string the document spelled it with. Those two go
together. The URL parser strips tab, carriage return and line feed as a silent repair, so a value
could pass a scheme check on the repaired parse while the raw string — which was what got stored —
still carried the line break, all the way into the platform browser launcher. The check and the
stored value are now the same value, and a value that only looks clean because the parser rewrote it
is refused rather than repaired. The same floor applies to GitHub's `endpoints.api`, which arrives
in Copilot's token-exchange response and becomes the base for requests carrying a live Copilot
token: it must parse and use `https`, or the descriptor's own host is used instead.

**The Windows browser launcher does not go through a shell.** `start` is a `cmd.exe` builtin, so
using it meant `cmd` re-parsing a command line with the authorization URL in it, and that second
parse could not be escaped safely: `^` escapes neither `%` — so `%USERPROFILE%` in a URL was
expanded and sent to whoever served it — nor a carriage return, which ends one command and begins
the next. The launcher now uses `rundll32 url.dll,FileProtocolHandler`, which takes the URL as an
argument and re-parses nothing. A URL containing a control character is not launched at all, on any
platform — a receiver that was given an `onAuthorizationUrl` callback has already handed the URL to
it by then, so a CLI that prints the URL still completes the login; one that relies solely on the
browser opening will wait out its timeout instead.

Two things follow from `rundll32` that are worth knowing before you rely on it. `FileProtocolHandler`
documents a URL limit of roughly 2048 characters, where `cmd /c start` allowed 8191 — long enough
for any authorization URL these providers build, but not unlimited. And `rundll32` is a technique
endpoint-protection products watch, so a managed Windows fleet may block or alert on it. Both
failures are silent at the moment they happen, so pass `onAuthorizationUrl` and print the URL if
your application cannot afford a login that simply does not start.

**Errors never carry a credential.** A failed token request quotes a snippet of the provider's
response, which is genuinely useful for diagnosis, but that body is not ours and a misconfigured
gateway echoing the request back would put a live refresh token straight into your logs. Snippets
pass through `redactSecrets()` first. Treat that as defence in depth rather than a guarantee: it
scrubs the OAuth parameters and the token shapes the supported providers issue, not arbitrary
secrets.

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
directory owned by, and writable only by, the user running the CLI.

Prefer `secureStoreAdapter` for refresh tokens on mobile. In a browser, any XSS on your origin can
read whatever web storage you chose. On a server, encrypt at rest.

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
