# @ai-oauth-sdk/cli

Sign in to an AI provider from the terminal and get a token you can pipe into
anything.

**[Documentation](https://ai-oauth-sdk.themonk.dev/docs/runtimes/cli)**

```bash
npx @ai-oauth-sdk/cli login openai

curl -H "Authorization: Bearer $(npx @ai-oauth-sdk/cli token openai)" \
     -H "OpenAI-Beta: responses=experimental" \
     "https://chatgpt.com/backend-api/codex/models?client_version=0.142.5"
```

Not `api.openai.com`: a ChatGPT sign-in grants the subscription surface, not the
REST API. `createAuthenticatedFetch` sends the right host and headers for you.

Install it properly to drop the `npx`:

```bash
npm i -g @ai-oauth-sdk/cli
ai-oauth-sdk login anthropic
```

## Commands

```
login <provider>      Sign in and store the token
token <provider>      Print a valid access token (refreshes if needed)
whoami <provider>     Show the signed-in account
list                  List all stored sessions
refresh <provider>    Force a token refresh
logout <provider>     Forget the stored token
providers             List supported providers
exec <provider> -- …  Run a command with the token in its environment
```

`token` prints the bare token to **stdout** and nothing else — everything human
goes to stderr, so `$(...)` capture is always clean. `--json` gives structured
output for every command.

## Keeping tokens out of your shell history

```bash
ai-oauth-sdk exec openai -- ./deploy.sh
```

The token arrives as `$AI_OAUTH_SDK_TOKEN` in the child's environment instead of on
the command line, where it would land in the process table and your history
file. Use `--env-var OPENAI_API_KEY` to name it something a tool already reads.

## Headless machines

```bash
ai-oauth-sdk login github-copilot --device   # type a code on your phone
ai-oauth-sdk login anthropic --paste         # print the URL, paste the result back
```

Plain `login` already picks sensibly: a loopback server on a desktop, and paste
over SSH or with no `DISPLAY`, where a loopback redirect could never arrive.

## Several accounts

```bash
ai-oauth-sdk login anthropic --account work
ai-oauth-sdk login anthropic --account personal
ai-oauth-sdk token anthropic --account work
ai-oauth-sdk list
```

## Any OAuth 2.0 provider

The built-ins are a convenience, not a limit:

```bash
ai-oauth-sdk login acme \
  --client-id my-client \
  --authorize-url https://auth.acme.dev/authorize \
  --token-url https://auth.acme.dev/token
```

The descriptor is saved alongside the token, so `ai-oauth-sdk token acme` works
afterwards without repeating the flags.

## Providers

`openai` · `anthropic` · `google` · `xai` · `github-copilot` · `openrouter` ·
`qwen`

`openai`, `anthropic`, `github-copilot`, `openrouter` and `qwen` work with no
setup. `google` and `xai` need credentials you register yourself — pass
`--client-id` (and `--client-secret` for Google).

## Where tokens live

`~/.ai-oauth-sdk/auth.json`, written `0600`. Override with `--auth-dir` or the
`AI_OAUTH_SDK_HOME` environment variable.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. These OAuth flows are not officially supported by any provider and may
change without notice — see the
[disclaimer](https://ai-oauth-sdk.themonk.dev/docs/resources/disclaimer).</sub>
