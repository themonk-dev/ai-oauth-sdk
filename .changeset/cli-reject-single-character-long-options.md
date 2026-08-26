---
'@ai-oauth-sdk/cli': patch
---

Reject `--<single character>` options instead of silently ignoring them, and stop reading flag names through `Object.prototype`.

`findUnknownFlag` skipped every one-character key with `if (name.length === 1 || known.has(name))`, on the theory that those are the short flags the commands read directly. They are not. `parseArgs` stores a bare one-character key only for a *real* short flag — `SHORT_FLAGS` is `h` and `v` — and deliberately keeps the leading dash on anything else, so an unrecognised `-x` arrives as the two-character key `-x` precisely so the guard can catch it. What the length check actually whitelisted was every double-dash single-character option.

The visible consequence is credential confusion. With a work and a personal account stored, `ai-oauth-sdk token acme --account work` prints the work token, but `ai-oauth-sdk token acme --a work` prints the **personal** token, with exit 0 and nothing on stderr — `--a` passes the guard, `--account` is never set, and the command falls back to the default account. The two-character typo `--ac` was rejected correctly the whole time, which is what made this easy to miss. Every `--<char>` was swallowed, not a few. The guard now skips a one-character name only when it is an actual member of `SHORT_FLAGS`; `-h`, `-v`, `-vh`, `--h` and `--v` all still work.

Two prototype-key reads went with it, from the same root cause of treating user-typed strings as safe object keys. `SUGGESTIONS[bare]` read straight through to `Object.prototype`, so `--constructor` was answered with `function Object() { [native code] }` as its hint; it is a `Map` now. And the `flags` record built by `parseArgs` is an `Object.create(null)`, because assigning to `__proto__` on an object literal is a silent no-op — `--__proto__ value` produced no own key at all, so the flag vanished rather than being reported as unknown.
