---
'@ai-oauth-sdk/cli': patch
---

Reject mistyped one-character long flags instead of silently discarding them.

The unknown-flag guard skipped every one-character key on the grounds that those are short flags,
but the long form produces one-character keys too — so `--r`, `--j` and every other
`--<single letter>` was accepted and thrown away. The worst case was `logout <provider> --r` for
`--revoke`: it printed the same `Signed out of …` line and exited 0 while sending no revocation
request and no "this provider has no revocation endpoint" warning, leaving a token the user believed
had been withdrawn live at the provider.

`--r` and friends are now reported as unknown options. `-h` and `-v` are unaffected.
