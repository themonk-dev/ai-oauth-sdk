---
'@ai-oauth-sdk/node': patch
---

Fix a crash that let any web page kill a process waiting on a loopback login.

The loopback receiver parsed the raw request target with `new URL(target, base)`, which reads a
target beginning `//` as protocol-relative and looks for an authority in what is only ever a path.
A bare `//` names none, so the parse threw, and `node:http` re-raises whatever a request handler
throws — the exception reached the default `uncaughtException` handler and ended the host process.
Since `openai` and `xai` bind fixed, published ports, `location = 'http://127.0.0.1:1455//'` on any
page the user happened to have open was enough to kill a CLI mid-login, without needing to get past
the method or `Sec-Fetch-*` checks.

Request targets are now required to be origin-form and parsed defensively. A malformed one is
answered `400` and otherwise ignored, exactly like the existing `403`/`404` refusals: the pending
callback is left unsettled and the server keeps listening, so the genuine redirect still completes.
The same change stops `//evil.com/callback` being accepted as the callback path on an authority the
request never named.
