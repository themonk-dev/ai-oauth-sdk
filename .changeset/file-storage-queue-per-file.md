---
'@ai-oauth-sdk/node': patch
---

Serialise `fileStorage()` writes per credential file rather than per adapter instance, so two clients in one process stop silently dropping each other's tokens.

`set` is a read-modify-rewrite of the entire record: read `auth.json`, add one key, write the whole thing to a temp file, rename it into place. That is only safe if the reads and writes are ordered, and the promise chain that ordered them lived in the closure of a single `fileStorage()` call — so it ordered one adapter against itself and nothing else.

`createNodeAuthClient` builds a fresh adapter per client. A process signed in to two providers, which is the ordinary case for anything wrapping more than one model, therefore holds two adapters over one file with two independent chains. Two concurrent `set` calls both read the same base record and the second rename discards the first's key. Nothing surfaces: both promises resolve, both callers believe the token was stored, and the loss is only visible on the next start-up, as a provider that has to be signed in to again. Two overlapping refreshes reach the same shape through `setTokens` on a single client, where the lost write is a *refresh* token — the refresh that produced it has already been redeemed and rotated, so the credential it replaced is dead too and the provider has to be re-authorized.

The chain now lives in a module-level map keyed on the credential file, so every adapter over that file queues behind the same tail. The key is the resolved absolute path, which puts a relative `--auth-dir` and the absolute path it denotes on one chain.

What this does not cover, stated plainly. It is a per-process guard: two `ai-oauth` processes writing one file concurrently are still racing, and closing that needs an advisory lock on disk with the stale-lock handling a lock implies — deliberately out of scope here, and not something the previous code attempted either. Two names that reach one file by other means — a symlinked directory, a bind mount, a case-insensitive filesystem where the spelling differs — resolve differently and still get separate chains. The rename remains atomic throughout, so neither case can produce a torn or truncated file; the failure they leave is the lost-update one, not a corrupt store.
