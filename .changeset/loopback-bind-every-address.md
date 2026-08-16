---
'@ai-oauth-sdk/node': patch
---

Bind every address the advertised loopback host resolves to, so the port cannot be squatted underneath the name.

`loopbackReceiver()` binds `127.0.0.1`. The redirect URI it hands the authorization server names `localhost`, which is what four of the five bundled loopback providers advertise — `defineProvider()` defaults `loopbackHost` to `'localhost'`, and only `xai` overrides it with the IP literal.

On a dual-stack machine `localhost` also resolves to `::1`, and browsers try `::1` first: Chromium's resolver returns the IPv6 literal ahead of the IPv4 one, and Happy Eyeballs gives it a head start of a few hundred milliseconds. So another local unprivileged process can bind `[::1]:<port>` and receive the callback while our own bind on `127.0.0.1` still succeeds. Port reservation is per address rather than per name, so the `EADDRINUSE` guard never sees it, and the login looks entirely normal — with no attacker present the browser simply fails over to `127.0.0.1` after ~300ms and everything works, which is why this stayed latent.

What the squatter gets is the authorization code and `state`, the ability to stall or silently kill any login, and control of the HTML on a URL the user was just told to trust. PKCE is what stops the code being redeemed — the verifier never leaves the victim's process — so this is disclosure and interception rather than token theft, for as long as the authorization server actually enforces the challenge. That is a control this library depends on and cannot observe, and it is absent entirely for any descriptor built with `usePkce: false`. `openai` is the sharpest case: a fixed, published port, so nothing has to be guessed.

RFC 8252 §7.3 recommends the IP literal precisely to avoid this, but OpenAI registered the `localhost` form of the redirect URI, so the fix cannot be to stop using the name — it has to be to own it. The receiver now binds the sibling address as well, and nothing about what is sent to the authorization server changes.

Failing to bind the sibling is only treated as an error when something is *holding* it. A host with IPv6 disabled cannot resolve `localhost` to `::1` either, so there is nothing there to take and the IPv4 bind is already complete; `EAFNOSUPPORT` and friends degrade silently. `EADDRINUSE` is the attack signal: on a fixed published port there is nowhere else to go, so the login is refused with an explanation rather than started, and on an ephemeral port — where a collision is as likely to be ordinary as hostile — the receiver takes a different port instead.

A provider that already advertises an IP literal, like `xai`, is untouched: nothing else can answer for an address, so there is no sibling to cover.
