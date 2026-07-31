---
'@ai-oauth-sdk/core': minor
'@ai-oauth-sdk/cli': patch
---

Publish a credential for every provider, and narrow Anthropic's scopes.

**`publicClientIds` gains `google` and `xai`.** Both descriptors previously said
no public client existed. That was wrong in both cases:

- xAI ships one with grok-cli, and it is not merely a convenience — xAI rejects
  any client it has not allowlisted (`invalid_client`, "Unknown or disabled
  client") and offers no self-service registration for a desktop CLI, so telling
  users to "supply your own" pointed at a dead end.
- Google ships one with gemini-cli, together with the installed-app
  `clientSecret` its token endpoint refuses the exchange without. OAuth and
  [Google's own docs](https://developers.google.com/identity/protocols/oauth2/native-app)
  treat installed-app secrets as non-confidential, so it is exported as
  `publicClientSecrets.google` and the CLI falls back to it the same way it
  already falls back to a client id.

Every built-in provider now has a credential to opt into, and
[docs/credentials.md](../docs/credentials.md) lists the raw values so the same
pair can be passed from the SDK, another language, or a config file. Everything
stays overridable — `clientId`/`clientSecret`, `--client-id`/`--client-secret`,
or `AI_OAUTH_SDK_CLIENT_SECRET`.

**Anthropic asks for what chat needs, and no more.** The default was the full set
Claude Code requests. Three of those are capabilities no caller needs in order to
send a prompt, and `org:create_api_key` is worse than unnecessary: it turns any
leaked token into durable organization API keys that outlive the OAuth session.

The default is now `user:inference user:profile user:sessions:claude_code` — the
Messages API, the identity `whoami` reads, and the session the grant belongs to.
`org:create_api_key`, `user:file_upload` and `user:mcp_servers` are opt-in:

```ts
createAuthClient({
  provider: 'anthropic',
  clientId: publicClientIds.anthropic,
  scopes: [...anthropic.scopes, 'org:create_api_key'],
})
```

Stored tokens are unaffected — they keep whatever they were granted. Sign in
again to narrow one.
