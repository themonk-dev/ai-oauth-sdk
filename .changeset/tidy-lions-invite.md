---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/node': patch
'@ai-oauth-sdk/cli': patch
'@ai-oauth-sdk/vue': patch
---

Refuse a URL carrying control characters before launching a browser, store the
discovery endpoint that was validated, and eight other holes.

**A discovery document could put arbitrary bytes on a Windows `cmd.exe` command
line.** `escapeForCmd` neutralises the characters `cmd` treats as syntax, but it
has no answer for a newline — `^` before one is line continuation, not an
escape — and a newline is a command separator. The route in was the gap between
what discovery checked and what it stored: `classifyDiscoveryUrl` validates an
endpoint with `new URL(value).protocol === 'https:'`, and the WHATWG parser
strips CR, LF and TAB *before* parsing, so `https://evil.test/a\r\ncalc\r\n`
reports `https:` and an `href` of `https://evil.test/acalc`. The raw string was
the one stored, and `appendQuery` copies everything before the first `?`
verbatim, so the control characters survived into `openBrowser` intact. Two
changes, either of which closes it: `openBrowser` now refuses a URL containing
a C0 control character, DEL, or a raw `"`, on every platform; and discovery now
stores the parsed URL, so what was checked and what is used are the same bytes.
Endpoints passed in explicitly are still neither checked nor normalised. `%VAR%`
expansion by `cmd` is unchanged and still documented — closing that means not
going through `cmd` at all.

**`resolveProvider` let an override that is present but `undefined` erase the
built-in beneath it.** `resolveProvider('claude', { scopes: config.scopes })`
with `scopes` unset deleted claude's minimised scope list, and the flow then
died in `createAuthorization` with a `TypeError`. That shape is what every
optional field read from parsed JSON or a CLI flag produces. The
`if (overrides.scopes?.length)` guard that followed the merge was reaching for
exactly this and could never work — the spread had already overwritten the key.
Every level is now filtered, `redirect` and `extraAuthParams` and `tokenRequest`
included. `AuthClient` was never affected; it guards each key in its
constructor.

**A bare IPv6 `host` crashed the loopback server's process.** The request base
was built from the raw `host` option rather than the normalised one, and an IPv6
literal is only legal in a URL authority when bracketed — so
`loopbackReceiver({ host: '::1' })` bound successfully and then threw
`TypeError: Invalid URL` inside the request listener, uncatchable, on the first
request past the method and `Sec-Fetch` gates. `'::1'` is not misuse: Node
rejects the bracketed form as a bind host, so the bare form is the only spelling
that binds the IPv6 loopback interface at all, and this module's own sibling
logic is written for it. The handler is now also wrapped so a future parse
failure answers 400 instead, without settling the pending callback.

**`defaultReceiver()` never actually fell back to paste.** Its docstring
promises that a headless environment does, and it delivered that only for a
provider with a `hostedUri` — which `claude` alone has. `openai`, `gemini`,
`xai` and `openrouter` got a loopback server, so over SSH the port bound on the
remote box while the redirect went to the laptop's own `localhost`, and the
process waited to `timeoutMs` or forever. That branch now returns a hybrid
receiver, which binds the port *and* offers the prompt. `mode: 'custom'`
providers — `github-copilot` and `qwen`, device-flow only — landed there on
every machine and were handed a loopback server advertising a redirect URI they
accept no registration for; they now reach `manualReceiver`'s purpose-written
error naming `deviceLogin()`.

**Every authenticated OpenAI request failed on bare React Native.** `applyQuery`
and OpenAI's `transformRequestBody` reached for `URL.searchParams` and
`URL.pathname`, the two members React Native's URL shim throws from — the reason
`query.ts` carries hand-rolled helpers in the first place. `applyQuery`'s early
return only spares providers that contribute no parameters, and OpenAI's
`apiQuery` contributes `client_version` to every request, so the throw landed
before anything was sent. `transformRequestBody` read the path on *every*
string-bodied request, before the check that would have returned the body
untouched. Both now use string handling; existing parameters are enumerated
first, because key order is what `encodeQuery` serialises in.

**`parseStandardCallback` could not read a fragment-mode callback.** The guard
asked whether the string still contained `code=` while that string *was* the
fragment, so a fragment carrying a code was never split off, and it required a
`?` to be present at all, so a custom-scheme deep link never reached it. The
branch worked only for a bare `#code=…` string, which no caller produces. The
asymmetry showed from outside: a fragment-borne `error=` parsed fine while a
fragment-borne success did not, so a user who completed consent was told no code
was returned. The fragment is now split first, and the query stays authoritative
when it carries the response.

**`scopes_supported` was the one discovery field taken on trust.** A server
answering with a string put a non-array into `provider.scopes`, and login failed
later on `scopes.join is not a function`, far from the cause and contrary to the
`configuration_error` the module contracts for. It is now type-guarded; adopting
the advertised list remains the policy.

**Prototype keys resolved through the provider and command maps.**
`resolveProvider('constructor')` returned a descriptor with `id: undefined`
instead of throwing `unknown_provider`, and in the CLI a command of `constructor`
or `toString` found an inherited member, skipped the unknown-command branch and
returned **0 with nothing on stdout or stderr** — where the contract is exit 1,
so a wrapper reading exit codes saw success. The provider maps did not fail safe
either: `resolveClientId('constructor')` returned the `Object` function where the
signature promises a string, and `logout constructor` reported "✓ Signed out of
undefined." Every one of those lookups now tests own-property membership.

**`logout` deleted a custom provider's descriptor while its sessions were still
live.** The guard stood `--account` in for "no sessions are left", which is wrong
in both directions: `logout acme` with no `--account` cleared `tokens:acme`,
left `tokens:acme:work` behind with a live refresh token, and deleted the one
descriptor every account slot shares — so the surviving session became
unreachable while `list` still listed it; and `logout acme --account work` on the
last session kept the descriptor forever. The condition is now asked of the
store.

**The Vue binding handed back a deep readonly proxy instead of the token set.**
`readonly()` proxies whatever `.value` returns, so `auth.tokens.value` was never
the `TokenSet` the store holds and `.raw` was a second proxy. A Proxy is not
structured-serialisable, so passing it to a worker threw `DataCloneError`, and it
compared unequal to the same token from `client.getTokens()`. It also
contradicted the `shallowRef` the file chose two dozen lines above, precisely
because a token set is replaced wholesale rather than reached into.
`shallowReadonly` keeps the ref write-protected while leaving the object alone;
the trade-off is that a write *into* it now lands rather than being swallowed,
which matches how the store treats a token set.
