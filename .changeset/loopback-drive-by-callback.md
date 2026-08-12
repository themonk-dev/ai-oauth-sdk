---
'@ai-oauth-sdk/node': patch
---

Refuse callbacks a browser marks as a subresource, and close the loopback server once it has served one.

`loopbackReceiver()` accepted any `GET` that reached the callback path. A `GET` at a loopback port is a *simple request*, so it needs no preflight and no cooperation from us: `new Image().src = 'http://127.0.0.1:1455/auth/callback?error=access_denied'` on any page the user happens to have open lands in the handler, `readCallback()` throws, and the pending login rejects with `authorization_denied`. Two of the bundled providers bind a published, fixed port — OpenAI on 1455 and xAI on 56121 — so the attacker does not even have to guess. A page firing that on a timer breaks every sign-in attempted while the tab is open.

Nothing is disclosed by it. The response is opaque to the page, PKCE holds, and the `state` check means a forged *success* is not on the table. What was on the table is denial of login: an arbitrary website reaching into a local process and cancelling something the user started, with the CLI reporting a provider denial that never happened.

The handler now reads the browser's own account of where the request came from. When `Sec-Fetch-Site` is present, is not `none`, and `Sec-Fetch-Mode` is anything other than `navigate`, the request is answered `403` and the callback promise is left alone — so the drive-by is a no-op and the genuine redirect, which arrives as `Sec-Fetch-Mode: navigate`, still completes. The headers are trusted only when the browser supplies them: `curl`, `undici` and any other non-browser caller send no `Sec-Fetch-Site` and are unaffected, and `none` is a URL typed into the address bar, which is legitimate.

No `Host` or `Origin` check was added, because neither one stops this. A cross-site `<img>` `GET` carries a perfectly valid `Host: 127.0.0.1:1455` and, being a no-CORS navigation-shaped fetch, no `Origin` at all — so both checks pass while the attack proceeds, and requiring an `Origin` would instead reject the real redirect.

The receiver also now closes itself as soon as a callback settles, guarded so a second request in flight cannot settle it twice. `SECURITY.md` already claimed it "serves exactly one callback before shutting down"; that was true of `login()`, which closes in a `finally`, but not of the receiver, which went on answering for the rest of the flow and would answer a second callback with a `200`. Closing waits for the response to flush, since closing destroys the sockets and would otherwise truncate the page in front of the user, and the caller's later `close()` stays safe — `server.close()` on an already-closed server invokes its callback rather than hanging.
