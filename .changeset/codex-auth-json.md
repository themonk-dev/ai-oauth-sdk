---
'@ai-oauth-sdk/core': minor
---

Add `codexAuthJson()` and `chatgptPlanType()` to the OpenAI provider, so a ChatGPT sign-in can drive the Codex CLI itself.

A ChatGPT subscription token does more than call `/responses`: written into `$CODEX_HOME/auth.json`, it lets `codex app-server` open the subscription's realtime voice call, run delegated turns, and refresh on its own. `codexAuthJson(tokens)` renders a `TokenSet` as that file, verified against `codex-rs/login` at 0.154.0.

Two of its fields are stricter than they look, and getting either wrong is silent: `id_token` must be a JWT carrying the `https://api.openai.com/auth` claims (the access token carries the same ones and stands in), and `refresh_token` must be a string, never `null`. Codex fails to parse the whole file otherwise, runs with no credentials, and sends the request to `api.openai.com`, where it fails with "You didn't provide an API key". The helper encodes both rules and throws `invalid_token_response` when the token set has no parsable claims at all.

`chatgptPlanType(tokens)` reads the plan (`free`, `plus`, `pro`, ...) off the same claim, `id_token` first, since a subscription-gated feature checks it before anything else.

The new `examples/voice-chatgpt` shows the whole path: device login in the browser, then GPT Live over WebRTC through a private `codex app-server`, with no API key anywhere. The docs' claim that speech-to-speech was unreachable from this token is withdrawn.
