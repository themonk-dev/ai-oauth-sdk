---
'@ai-oauth-sdk/core': patch
'@ai-oauth-sdk/cli': patch
---

Fix three ways the CLI could hang or refuse a login.

**`--paste` worked for exactly one provider.** `manualReceiver` fell back to the
provider's hosted redirect URI and nothing else, so pasting worked for Anthropic
and threw `configuration_error` for every loopback provider — openai, google,
xai and openrouter, which is most of them and precisely the case `--paste` is
meant to rescue. It now synthesises the loopback URI the provider expects,
including for providers that accept any port, where nothing is listening and the
value only has to round-trip into the token request unchanged.

**`login github-copilot` waited for a callback that could never arrive.**
Providers with no redirect at all can only be completed by device code, but
without `--device` they were handed a loopback server. The flow is knowable from
the descriptor, so it is now chosen automatically; `--paste` on one of those
fails immediately and names `--device` instead of hanging.

**`--timeout` did nothing on a device login.** `deviceLogin` takes an
`AbortSignal` rather than a timeout, so the flag was silently dropped and polling
ran to the provider's own expiry — around fifteen minutes of an apparently frozen
terminal. It is wired through both login paths now.
