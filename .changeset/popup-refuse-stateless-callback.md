---
'@ai-oauth-sdk/browser': patch
---

Refuse a state-less broadcast callback when the attempt presented a `state`.

`popupReceiver` matched a callback to its attempt by disqualifying only a disagreement, so a payload carrying no `state` was taken by an attempt that had one. That is the shape a stray or hostile broadcast arrives in. The redirect page announces whatever query string it was loaded with, and `readCallback` turns a denial — or an empty query — into a rejection with no `state` attached, so taking one cancelled a live sign-in rather than being ignored.

A cross-origin link that opens this origin's redirect page on `?error=access_denied` was enough, and where the app's root is its own redirect page, which is what `autoReceiver` arranges on a loopback origin, a second tab of the app did it with no attacker at all. The receiver is the only place this can be caught: a rejected `wait()` throws out of `login()` before the client's own `state` comparison, which sits after the await.

Nothing to compare is still not a mismatch. An authorization URL that carried no `state`, or a provider declaring `echoesState: false` because its callback will not bring one back, leaves the receiver no attempt to tell callbacks apart by, and one is taken as it comes — the same exemption the client itself makes, with the same caveat that such a provider cannot tell two concurrent sign-ins apart.
