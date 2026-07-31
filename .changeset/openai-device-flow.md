---
'@ai-oauth-sdk/core': minor
'@ai-oauth-sdk/cli': patch
---

Add OpenAI's device flow.

**`openai` can now sign in headlessly.** `codex login --device-auth` has an
equivalent here: `client.deviceLogin()`, or `ai-oauth-sdk login openai --device`.

It shares the *shape* of RFC 8628 and none of the wire format, so it could not
be a flag on the existing implementation:

- request and poll bodies are JSON, not form encoding
- "not approved yet" is HTTP 403 or 404, not `error=authorization_pending`
- the identifiers are `device_auth_id` + `user_code`, not one `device_code`
- approval yields an authorization code plus **the PKCE verifier the server
  generated**, which then goes through the ordinary token endpoint against a
  fixed hosted redirect

`ProviderConfig` gains an optional `deviceFlow`, so a provider that deviates
supplies its own two steps while every RFC 8628 provider keeps working from
`deviceAuthorizationUrl` alone. Exported as `openaiDeviceFlow` for anyone
building on it directly.

**The CLI's provider table shows both flows**, e.g. `loopback +device`, so the
headless option is discoverable where people look for it.

**OpenAI's device flow needs turning on per account** — "Enable device code
authorization for Codex" under ChatGPT → Settings → Security. Without it the
verification page refuses the code while the endpoint keeps answering 403, so
the CLI sat at "Waiting for approval…" for fifteen minutes with no clue why.
Providers can now declare a `devicePrerequisite`, and the CLI prints it above
the code rather than leaving the user to discover it in a browser.

**`--timeout` now says it timed out.** It aborted the flow internally, so the
CLI reported `aborted`, which reads like the user pressed ctrl-C.
