---
'@ai-oauth-sdk/node': patch
---

Stop a malformed request target killing the process the loopback receiver runs
in, and bracket an IPv6 bind host before parsing against it.

The callback handler built its parse base as `` `http://${bindHost}` `` and
called `new URL()` on the request target with no guard. Node's HTTP parser is
laxer than the URL parser and hands a target it will not accept to the `request`
listener rather than rejecting it at `clientError`, so `new URL()` throws
`ERR_INVALID_URL` synchronously inside a listener. Node does not catch throws
from its own listeners and a library must not install an `uncaughtException`
handler, so the throw walks out of the event loop and exits the embedding
process with code 1 — the CLI, the desktop agent, whatever was mid-login.

Nothing exotic is needed to send one. `//[` is an ordinary origin-form target
that `new URL()` on the client side keeps intact, so a plain browser navigation
to `http://127.0.0.1:1455//[` puts it on the wire. Shaped as a top-level
navigation it carries exactly the `Sec-Fetch-*` values the drive-by check is
looking for and reaches the parse. `openai` binds a fixed, published 1455 and
`xai` a fixed 56121, so there is no port to guess: any page the user happens to
have open can terminate the process. `//[x`, `http://[`, `http://[::1` and
`http://%` do the same; `/%`, `*` and `/a%2` parse fine and always did.

A target that will not parse is now answered `400` and nothing else happens —
the pending callback is left alone and the server keeps listening, the same way
a drive-by denial is refused. Settling on it would hand an attacker the cancel
that the `Sec-Fetch-*` and `state` checks already exist to deny.

The base is also built from the bracketed form of the bind host, which is a
separate break with no attacker in it at all. `host` is documented as the
interface to bind, and `::1` is the only spelling `listen()` takes — `[::1]`
fails `ENOTFOUND`. Dropped unbracketed into the base that makes `http://::1`,
which is not a URL, so `loopbackReceiver({ host: '::1' })` threw on the first
well-formed callback it received and took the process with it. Guarding the
parse alone would have turned that from a crash into a `400` on every legitimate
redirect, which is not better.
