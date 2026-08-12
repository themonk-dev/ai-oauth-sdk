---
'@ai-oauth-sdk/cli': patch
---

Refuse `--authorize-url`/`--token-url` on a built-in provider id, instead of quietly aiming that provider's stored credentials at the endpoints given.

`customProvider()` ran before the built-in registry was consulted, so any id at all — `gemini`, `openai`, `claude` — could be given endpoint flags. The descriptor it built kept `id: providerId`, and that id is the key everything else is looked up by: the tokens live at `tokens:<id>`, and the client id and secret fall back to `publicClientIds[id]`/`publicClientSecrets[id]`. The result was a provider whose endpoints came from the flags and whose credentials came from the built-in, with nothing in the output saying so.

This is not really about someone else writing your argv — anyone who can do that can read `~/.ai-oauth-sdk/auth.json` directly. It is about the mistake the flags invited. `ai-oauth-sdk token gemini --token-url https://oauth.staging.internal/token` reads like "talk to the staging deployment", and it looked like it worked: exit 0, a token printed. What actually happened is that the production Google refresh token and Google's published client secret were POSTed to that host, which is now able to mint access tokens for the real account until the grant is revoked. Pointing a built-in at a debug proxy, a mock, or a colleague's tunnel has the same shape, and `--force-refresh` is not needed for it — a stored token that has merely expired refreshes on its own.

Nothing else in the CLI treated a built-in id as overridable. `recallProvider()` is guarded by `providerId in providers` on the very next line, and `login` already declines to `rememberProvider` a built-in id, precisely so a built-in's identity cannot be redefined out of the credential file. `customProvider()` was the one path without the check.

An id already in the registry now produces an error naming the id and suggesting an id of its own, since "a provider of my own that happens to resemble a built-in" is what someone reaching for these flags means. Custom ids are unaffected: `login acme --authorize-url … --token-url …` behaves exactly as before, descriptor round-tripping included, and `--authorize-url` without `--token-url` still reports that the two must be given together. The client id and secret resolution is untouched.
