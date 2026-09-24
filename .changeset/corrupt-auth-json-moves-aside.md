---
'@ai-oauth-sdk/node': patch
---

Move an unparseable `auth.json` aside rather than letting the next sign-in overwrite it, so one bad byte stops wiping every other provider's credentials.

`readAll` mapped a `SyntaxError` to an empty record, on the reasoning that a corrupt credential file should not wedge login — which is right, and a test pins it. The problem is that `set` rewrites the *whole* file from whatever `readAll` returned. So the empty record was not only what the caller saw; it was the base of the next write. Signing in to one provider against a corrupt file therefore deleted the stored refresh tokens for all the others, silently, in the course of a command that looked like it succeeded. A zero-length `auth.json` — a realistic artifact of a crash or a full disk, and a file that parses no better than garbage — has the same effect.

The file is now renamed to `auth.json.corrupt-<timestamp>` before the empty record is returned. Both properties survive: login still does not wedge, because the read still resolves, and the old credentials are still on disk for a human to salvage rather than gone. `rename` keeps the inode, so the `0600` mode carries over; the suffix puts the file outside every path the adapter reads — `auth.json` and `auth.json.<hex>.tmp` — so it cannot be picked up as the record later. A rename that fails is swallowed, because a read-only directory should not turn a read into a throw.

Sweeping those files is left to the user. They are the only copy of the tokens that were there, so removing them on a schedule would be the same data loss by a slower route; `0600` and the `0700` directory are what guards them, as with `auth.json` itself.

No `fsync` is added. Making the rewrite durable against power loss is a different problem from this one, and it would cost a disk flush on every token refresh.
