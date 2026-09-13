---
'@ai-oauth-sdk/node': patch
---

Write the paste prompt to stderr, so stdout stays the data channel.

`promptReceiver()` wrote its instructions with `stdout.write` and built its readline interface with `output: stdout`. The CLI's stated contract, at the top of `packages/cli/src/output.ts`, is the opposite: stdout carries the result and nothing else, which is what makes `ai-oauth-sdk login claude --paste --json > out.json` produce a file worth capturing.

Redirect stdout and both halves of the prompt went into the file instead of to the user. `out.json` was not parseable JSON, and the terminal showed nothing at all while the process sat waiting on a paste — the user had no way to know it wanted one. Moving only the instructions would have fixed half of it: readline writes its own `"Paste the authorization code or URL: "` through `output`, and does so even when `terminal` is false, so the interface had to move too.

This is a channel bug, not a credential leak, and worth being precise about. With stdout redirected, readline sees a non-TTY `output`, sets `terminal` false and echoes nothing; what the user sees of their own paste is the tty's local echo of stdin, which never enters the redirected stream. Nothing pasted was ever captured.

`defaultReceiver()` had the same `process.stdout.write` in its last branch, where it prints the authorization URL for a provider that supports neither a local redirect nor a hosted page. That moves to stderr too — the branch most likely to be running on a headless box with output redirected somewhere is not one to leave half-fixed.

One behavioural consequence: readline's `terminal` now follows `stderr.isTTY` rather than `stdout.isTTY`. That is the reading the option wants, since `terminal` governs how the prompt is drawn and the prompt is now drawn on stderr, and it improves the redirected case — a piped stdout with a terminal on stderr now gets a real prompt instead of a silent read.
