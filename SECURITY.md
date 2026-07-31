# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue — use
[GitHub's private vulnerability reporting](https://github.com/themonk-dev/ai-oauth-sdk/security/advisories/new)
for this repository.

Include what you can: affected version and package, a description, and ideally a
reproduction. We'll acknowledge and keep you posted on a fix.

## What this library does and does not protect

`ai-oauth-sdk` obtains OAuth tokens and hands them to you. **Once a token is in your
process, protecting it is your responsibility.** The library does not encrypt tokens
in memory, and cannot stop your application from logging or transmitting them.

### Design choices worth knowing

**PKCE is on by default** (S256) for every redirect-based provider. The verifier is
persisted only for the flow's lifetime — a 10-minute TTL — and consumed exactly once,
so a replayed callback cannot replay the exchange.

**Randomness never degrades.** If a runtime has no `crypto.getRandomValues`, the
library throws rather than falling back to `Math.random()`. A guessable `state` or
PKCE verifier defeats the point of both. SHA-256 *does* have a pure-JS fallback,
because a hash handles no secrets — that's what makes PKCE work on Hermes without a
native polyfill.

**`state` is verified** on the callback, in constant time, and pending records are
single-use. A callback that carries *no* `state` is rejected rather than waved
through — anyone can reach a loopback port or post to an opener, so omitting the
parameter must not be a way to skip the check. If you write your own
`CallbackReceiver`, it has to return the `state` it received.

Providers that don't return `state` (OpenRouter) must set `echoesState: false`, which
resolves against the most recently started flow instead. There is no CSRF guard in
that path — it is fine for a CLI or single-flow app, and **not safe in a multi-user
server**.

**`TokenSet.raw` holds a second copy of every credential**, because it is the token
endpoint's response verbatim. Don't log it or ship it to telemetry; the named fields
(`accessToken`, `refreshToken`, …) are what you want.

**Token storage** is pluggable and defaults to memory. The provided adapters:

| Adapter | Protection |
|---|---|
| `fileStorage()` (Node) | `0600`, atomic temp-file rename |
| `sessionStorageAdapter()` (browser, default) | Survives the redirect, not the tab |
| `localStorageAdapter()` (browser) | Readable by any script on the origin |
| `secureStoreAdapter()` (Expo) | Keychain / EncryptedSharedPreferences |
| `asyncStorageAdapter()` (RN) | **Not encrypted at rest** |

For refresh tokens on mobile, prefer `secureStoreAdapter`. In a browser, remember that
any XSS on your origin can read whatever web storage you chose.

**The loopback server** binds `127.0.0.1` — never `0.0.0.0` — and serves exactly one
callback before shutting down. On a shared machine, any local process can in principle
connect to a loopback port; this is inherent to RFC 8252 and is why PKCE matters.

**Popup callbacks are origin-checked** before being trusted, and
`postCallbackToOpener` posts to its own origin rather than `*`.

**Errors never carry a credential.** When a token request fails we quote a snippet
of the provider's response, which is genuinely useful for diagnosis — but that body
is not ours, and a misconfigured gateway echoing the request back would put a live
refresh token straight into your logs. Snippets are passed through `redactSecrets()`
first, which scrubs the OAuth credential parameters and the token shapes the
supported providers issue. It is defence in depth, not a guarantee: do not rely on it
to make an arbitrary secret safe to print.

**`state` is compared in constant time.** A plain `!==` short-circuits at the first
differing character, which in principle turns a 256-bit guess into an incremental
one. The practical risk is low — an attacker also needs a usable `code`, and the
pending record is single-use — but the comparison sits on the security boundary.

**The loopback server answers `GET`/`HEAD` only**, and sends `no-store`,
`no-referrer` and `nosniff` on every response. The callback URL carries the
authorization code in its query string, so it must not be cached or leak through a
`Referer`.

**Published tarballs carry npm provenance.** Every package is published from CI with
`provenance: true`, producing a signed attestation that links the tarball to the
commit and workflow that built it. Verify with `npm audit signatures`.

**JWTs are decoded, never signature-verified.** They arrive over TLS directly from the
token endpoint and are read only for convenience fields (account id, email). Do not
pass third-party tokens to `decodeJwtPayload` and treat the result as authenticated.

### Client credentials

The client ids shipped for OpenAI, Anthropic, GitHub Copilot, Qwen, Google and xAI are
public, PKCE-protected values published by those vendors' own CLIs. They are not
secrets. One client *secret* is embedded: Google's, because its token endpoint refuses
an installed-app exchange without one and Google documents those secrets as
non-confidential. Everything is overridable — see
[docs/credentials.md](docs/credentials.md).

Using a vendor's CLI client id means presenting yourself as that CLI. Review the
provider's terms before shipping it in a product — and see [DISCLAIMER.md](DISCLAIMER.md),
which covers what this project is and is not in relation to those vendors.

**The CLI never persists a client secret.** It reads one from `--client-secret` or
`AI_OAUTH_SDK_CLIENT_SECRET` per invocation and keeps it out of the credential file, so a
value that was transiently visible in `ps` does not become a durable copy on disk.
Prefer the environment variable — a flag lands in shell history too.

## Supported versions

Pre-1.0: fixes land on the latest minor. Once 1.0 ships, the current major will
receive security fixes.

Runtime support tracks Node's own calendar: the packages declare `engines: >=22`
and CI covers Node 22, 24 and 26. Node 18 and 20 are past end-of-life and are no
longer tested — the code has no dependency on anything newer, so they will very
likely still work, but do not rely on it for anything you care about.
