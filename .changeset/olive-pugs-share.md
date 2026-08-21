---
'@ai-oauth-sdk/node': patch
---

Treat an empty `AI_OAUTH_SDK_HOME` as unset instead of writing credentials to the working directory

`AI_OAUTH_SDK_HOME=""` used to be taken as a directory, and the empty directory joined with
`auth.json` is the relative path `auth.json` — so the credential file, refresh token included,
landed in whatever directory the process happened to start in, while the CLI reported it as
`/auth.json`. An empty value is what a compose file, a workflow `env:` block, or
`export AI_OAUTH_SDK_HOME="$UNSET_VAR"` produces when the value behind it is missing, and in CI the
working directory is the checked-out repository.

Empty now falls back to `~/.ai-oauth-sdk`, matching `--auth-dir`, which has always read an empty
value as absent — and the reported path is correct again. A non-empty relative value such as
`AI_OAUTH_SDK_HOME=.creds` is still honoured. `fileStorage({ dir: '' })` falls back the same way.
