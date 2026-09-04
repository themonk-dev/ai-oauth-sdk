---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/node': patch
---

Arm the loopback `state` check when the port is bound, not when `present()` runs.

`loopbackReceiver()` matches a callback to its attempt by the `state` it presented, and treats "nothing presented" as "nothing to compare, take it as it comes" — the exemption that keeps a receiver driven directly through `start()` working. But `start()` is what binds the port, and `present()` does not follow until the client has minted a `state`, derived a PKCE pair and written both to storage. For that window the check was simply off, and a callback landing in it settled the pending promise and closed the server.

That is enough to steal the code. `openai` publishes port 1455 and `xai` 56121, so a local process can sit on one and flood `GET /callback?error=access_denied` at it; measured against this receiver the window is around a millisecond, and about 7% of logins land inside it. Winning frees the port, the attacker rebinds it, and the browser then delivers the genuine authorization code to their server a second later. PKCE still stops the code being redeemed — the verifier never leaves this process — so what it costs is the login, plus control of a page on a URL the user was told to trust. `SECURITY.md` said such a request "is refused without touching the pending callback and the real redirect still completes", which was true only once `present()` had run.

The receiver cannot tell on its own whether a `state` is still coming, so the caller says. `ReceiverContext` gains an optional `presents`, `AuthClient.login()` sets it — it always presents, a few lines after `start()` — and a receiver so told refuses every callback until it has presented: no authorization URL exists yet, let alone one handed to a browser, so nothing legitimate can be arriving. `hybridReceiver()` passes the promise through to its loopback half, which it presents exactly when it is itself presented.

Nothing changes for a caller that drives `start()` on its own. It sets no `presents`, may never present at all, and still takes callbacks as they come — the same deliberate exemption, now claimed rather than inferred. A provider declaring `echoesState: false` remains exempt as before.
