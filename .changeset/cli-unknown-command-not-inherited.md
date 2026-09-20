---
'@ai-oauth-sdk/cli': patch
---

Report inherited object names as unknown commands and options.

The command and flag-hint lookups walked `Object.prototype`, so names that live there were answered
by it. `ai-oauth-sdk toString` and `ai-oauth-sdk constructor` skipped the "Unknown command" branch,
printed nothing at all and exited 0 — enough for a wrapper written as `ai-oauth-sdk "$cmd" ||
fallback` to take the success path for a command that did nothing. `valueOf`, `hasOwnProperty` and
`__proto__` exited 1, but with a message from the wrong layer rather than the one meant for them,
and `--toString` printed `function Object() { [native code] }` where a hint sentence belongs.

The parsed flag object had the same problem from the other side: `--__proto__` never became an own
property of it, so the unknown-flag guard never saw the name and the flag was accepted and silently
discarded, taking the following argument with it.

All of these now produce the ordinary `Unknown command` / `Unknown option` output.
