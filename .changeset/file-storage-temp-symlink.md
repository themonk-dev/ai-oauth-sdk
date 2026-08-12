---
'@ai-oauth-sdk/node': patch
---

Refuse a symlink planted at `fileStorage()`'s temporary path, instead of writing every provider's tokens through it.

The temporary file was named `auth.json.<pid>.tmp` and opened with the default `w` flag. Neither half was safe on its own. The name is fully predictable — `pid_max` is small and `/proc` removes even the guessing — and a `w` open follows a symlink already sitting at that path. Anyone who could write to the credential directory could point that name at a file they owned and receive the entire record: every provider's access *and* refresh tokens, in one write.

`mode: 0o600` did not prevent it. The mode applies only when `open(2)` actually creates the inode, so an attacker who pre-created the target kept their own permissions on it, and the `chmod` that follows the rename fails `EPERM` on a file we do not own — a failure that was already being swallowed.

The write now passes `wx` (`O_CREAT|O_EXCL`), which refuses to follow a trailing symlink, and the name carries eight random bytes instead of the pid. The random name is not decoration: with `O_EXCL` and a predictable name, one stale temporary file — left behind by a crash, under a pid the system has since recycled — would turn every later write into an `EEXIST` and wedge the credential store permanently.

This is a hardening fix, not a break in the default configuration: `~/.ai-oauth-sdk` is created `0700` and is not writable by other users. It matters when `dir`, `--auth-dir` or `AI_OAUTH_SDK_HOME` points somewhere shared — a group-writable team cache, a container bind mount — and Linux's `fs.protected_symlinks` does not help there, since it only covers world-writable *sticky* directories.

`fileStorage()` still cannot defend a credential directory other local users can write to, because a directory that already exists keeps the permissions it already had. `SECURITY.md` now says so rather than implying otherwise.
