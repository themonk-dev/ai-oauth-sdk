---
'@ai-oauth-sdk/core': patch
---

Bound `interval` and `expires_at` in the OpenAI device flow, as the RFC 8628 flow already does

`openaiDeviceFlow.start()` took both fields from the response as given, while
`startDeviceAuthorization()` has clamped its equivalents for some time. A tiny positive
`interval` such as `0.001` passed the existing "greater than zero" check and polled with a
1 ms delay; a huge one overflowed `setTimeout`'s 32-bit delay and fired immediately instead of
waiting; and an `expires_at` far in the future removed the poll loop's only exit, since
`deviceLogin()` takes no timeout and the CLI passes a signal only when `--timeout` is given.
`interval` is now clamped to 1–60 s and `expires_at` to at most 24 hours out.

This is hardening for parity with the RFC 8628 path, not a fix for a reachable attack. The
endpoints are hardcoded constants, so no caller configuration reaches them: the only party who
can send these values is OpenAI, or someone who has broken or terminates the TLS connection —
and that party already has strictly more power here, because the approved poll is where the
authorization code and the PKCE verifier come from in the first place.

Behaviour you already rely on is unchanged: a missing, zero, negative or non-numeric
`interval` still falls back to 5 s, and a missing `expires_at` still gives 15 minutes.
