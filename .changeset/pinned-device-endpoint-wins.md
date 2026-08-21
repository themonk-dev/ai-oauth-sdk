---
'@ai-oauth-sdk/core': patch
---

Let an explicitly pinned `deviceAuthorizationUrl` survive `providerFromDiscovery()`.

`authorizationUrl` and `tokenUrl` were resolved as `input.X ?? document.Y`, so anything you passed won over the document. The device endpoint was not: it was spread into the descriptor *after* `...input`, so the document's `device_authorization_endpoint` overrode it unconditionally. An integrator who pinned all three endpoints — precisely so as not to take a remote document's word for where credentials go — still ran their device flow against whatever host the document named, silently.

What the winning host receives is the uninteresting half: a `client_id` and a PKCE challenge, both public by design. What it *chooses* is the whole device response — `user_code`, `verification_uri`, `verification_uri_complete` — which a CLI reads out to the user verbatim ("Open <url> / Enter code <X>"). That is the setup for an ordinary device-code relay: whoever controls the document opens its own device authorization at the real IdP, hands our user that code alongside the real verification URI so nothing looks wrong, and redeems the tokens once the user approves. Our own poll goes to the pinned token endpoint and fails, so what the user sees is a login that did not work, and they try again. The adversary is the discovery host, whoever compromises it, or a tenant-supplied issuer URL — a party `SECURITY.md` already describes as one you have not vouched for. The existing https check did not help: an attacker writing the document names an https endpoint of their own without effort.

The device endpoint now resolves as `input.deviceAuthorizationUrl ?? document.device_authorization_endpoint`, and the https validation applies only when the value did come from the document — the same rule, and the same `== null` test, as its two siblings. A pinned endpoint is your own config and is neither replaced nor validated, exactly as a pinned `tokenUrl` already was. Nothing changes when you do not pin one: the document still supplies it, and an `http` value there is still refused.

Fixed by resolving with `??` rather than by reordering the spread. Object spread copies an own key whose value is `undefined`, so hoisting the document above `...input` would have let an `input` carrying an explicit `deviceAuthorizationUrl: undefined` clobber a perfectly good document value.
