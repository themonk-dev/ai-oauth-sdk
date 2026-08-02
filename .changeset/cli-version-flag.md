---
'@ai-oauth-sdk/cli': patch
---

Fixed `-v` and `--version`, which printed the help text instead of the version.

The help branch matched on "no command" and ran first, so it swallowed every
invocation that was only a flag. `ai-oauth-sdk version` worked, and so did
`ai-oauth-sdk login --version`, but the spelling most people reach for did not.

The same ordering hid unknown options given without a command:
`ai-oauth-sdk --typo` printed help and exited 0, which is a success code for a
mistake. It now reports the unknown option and exits 1. An unknown command is
still reported ahead of an unknown option, since the command is what decides
which options are known.

`version`, `help`, `-v`, `-h` and the `ls` alias are now listed in the help
text, and its multi-account example no longer uses a provider id that was
renamed in 1.0.0.
