---
'@ai-oauth-sdk/node': patch
---

Read `EACCES` on a fixed loopback port as "someone is holding it".

`EADDRINUSE` is not the only way a kernel says a port is taken. libuv binds
with neither `SO_REUSEADDR` nor `SO_EXCLUSIVEADDRUSE`, and on Windows a second
bind against that arrangement reports `WSAEACCES` — surfacing as `EACCES` —
rather than `EADDRINUSE`, whenever the existing holder took the wildcard
address under a different user account or took it with `SO_EXCLUSIVEADDRUSE`,
which Microsoft recommends every server do. A wildcard holder on
`0.0.0.0:1455` does receive connections addressed to `127.0.0.1:1455`, so that
is a holder which genuinely intercepts.

`loopbackReceiver` treated it as an unusable machine and threw a bare errno.
`hybridReceiver` tells a refusal from a kernel saying no by *type* — an
`OAuthError` is a refusal, anything else degrades — so `--paste` then went
ahead and advertised the provider's fixed loopback URI with the squatter still
on it, and the browser delivered the authorization code to them while the
terminal sat at the paste prompt. That is the bypass the sibling-address
refusal already closes for `EADDRINUSE`; this closes it for the other errno.
PKCE still stops the captured code being redeemed.

Only for a fixed port. An ephemeral bind refused by a sandbox is the case
`--paste` exists to serve — no published address is at stake — and the
containers that do this report `EPERM`, which keeps degrading.
