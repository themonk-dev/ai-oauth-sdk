---
'@ai-oauth-sdk/node': patch
---

Remove `fileStorage()`'s temporary file when the write to it fails, instead of leaving every provider's tokens behind in plaintext.

The write path already cleaned up after itself when the *rename* failed. The `writeFile` above it did not: it recognised `EEXIST` — the planted-symlink refusal — and rethrew everything else untouched, temp file included. So a `ENOSPC` part-way through the write, an `EIO`, or a quota refusal left `auth.json.<hex>.tmp` on disk holding as much of the record as got flushed, which in practice is every provider's access *and* refresh tokens.

Nothing ever swept it. The temp name carries eight random bytes, so no later write reuses it and no later write trips over it; `logout` rewrites `auth.json` and does not know the file exists. It outlives the signing-out that was supposed to remove the credentials, and the only thing standing between it and another local user is its `0600` mode and the directory's — which is the same protection `auth.json` has, except that the user has been told `auth.json` holds their tokens and has never heard of this file.

The unlink is placed deliberately *below* the `EEXIST` branch, and a test pins it there. On `EEXIST` the file at that path is not ours — it is whatever was already sitting there, which is exactly the symlink `O_EXCL` just refused to follow — and unlinking it would clear the way for the retry the attacker was denied, undoing the protection.

An interrupted *process* (a `SIGINT`, a kill, a power loss) still leaves a temp file; catching that means a signal handler racing an in-flight rename, and it is not attempted here. The stale file is inert either way — the rename is atomic, so `auth.json` is never the truncated one.
