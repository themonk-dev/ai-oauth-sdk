
<div align="center">

![AI OAuth SDK](https://shieldcn.dev/header/dots.svg?title=AI+OAuth+SDK&subtitle=Sign+in+with+ChatGPT%2C+Claude%2C+Gemini%2C+Grok%2C+or+Copilot+from+a+single+SDK.&logo=ri%3APiFingerprintLight&size=wide&mode=dark&brand=themonk-dev)

<p>
<a href="https://www.npmjs.com/package/ai-oauth-sdk"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/npm/v/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="npm" src="https://www.shieldcn.dev/npm/v/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://www.npmjs.com/package/ai-oauth-sdk"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/npm/dm/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="npm downloads" src="https://www.shieldcn.dev/npm/dm/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://github.com/themonk-dev/ai-oauth-sdk/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/ci/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="CI" src="https://www.shieldcn.dev/github/ci/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://github.com/themonk-dev/ai-oauth-sdk/commits/main"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/last-commit/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="Last commit" src="https://www.shieldcn.dev/github/last-commit/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/license/themonk-dev/ai-oauth-sdk.svg?variant=ghost&amp;size=xs&amp;mode=dark"><img alt="License" src="https://www.shieldcn.dev/github/license/themonk-dev/ai-oauth-sdk.svg?variant=ghost&amp;size=xs&amp;mode=light"></picture></a>
</p>

**[Documentation](https://ai-oauth.themonk.dev/docs)** ·
[Quickstart](https://ai-oauth.themonk.dev/docs/quick-start) ·
[Providers](https://ai-oauth.themonk.dev/docs/providers) ·
[Recipes](https://ai-oauth.themonk.dev/docs/recipes) ·
[Reference](https://ai-oauth.themonk.dev/docs/reference/auth-client) ·
[Security](SECURITY.md) ·
[Disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer)

</div>

<br />

Every AI coding CLI ships its own copy of the same 400 lines: mint a PKCE pair, open a
browser, catch the callback on a loopback port, exchange the code, refresh before expiry.

This is that logic, extracted once, with the provider quirks already encoded. It does one
job. **Redirect the user, receive the callback, hand you the token.** There is no API client
here, no proxy, and no model wrappers.

```bash
npm i ai-oauth-sdk
```

```ts
import { login, publicClientIds } from 'ai-oauth-sdk/node'

// You name the client id, the way Passport does. Nothing presents as a
// vendor's CLI by accident.
const { accessToken } = await login('openai', { clientId: publicClientIds.openai })
```

Or from a terminal, with nothing installed:

```bash
npx @ai-oauth-sdk/cli login openai
```

> [!WARNING]
> **Built for fun and for learning.** This is an independent, unofficial project, and none of
> these providers supports third-party OAuth clients. Several of them also restrict what you
> may do with a credential issued to their own CLI, so getting a token is not the same as
> being allowed to use it. Read their terms, read the
> [disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer), and use it at your own
> discretion.

## Documentation

Everything is at **[ai-oauth.themonk.dev](https://ai-oauth.themonk.dev/docs)**.

| | |
|---|---|
| [Quickstart](https://ai-oauth.themonk.dev/docs/quick-start) | The shortest path to a token in each runtime |
| [Overview](https://ai-oauth.themonk.dev/docs/overview) | What it does, and where the provider differences live |
| [Runtimes](https://ai-oauth.themonk.dev/docs/runtimes) | CLI, Node, browser, React Native, script tag |
| [Frameworks](https://ai-oauth.themonk.dev/docs/frameworks) | React, Vue, Svelte, Solid |
| [Flows](https://ai-oauth.themonk.dev/docs/flows) | Loopback, popup, redirect, device code, paste |
| [Providers](https://ai-oauth.themonk.dev/docs/providers) | The eight built-ins, and how to describe your own |
| [Recipes](https://ai-oauth.themonk.dev/docs/recipes) | Server callbacks, multi-user, storage, using the token |
| [Reference](https://ai-oauth.themonk.dev/docs/reference/auth-client) | Every method, option and error code |
| [Credentials](https://ai-oauth.themonk.dev/docs/resources/credentials) | The published client ids, and registering your own |
| [Troubleshooting](https://ai-oauth.themonk.dev/docs/resources/troubleshooting) | The failures people actually hit |

## Packages

| Package | Purpose |
|---|---|
| [`ai-oauth-sdk`](packages/ai-oauth-sdk) | Umbrella and CDN build. **Start here.** |
| [`@ai-oauth-sdk/core`](packages/core) | Zero-dep engine: PKCE, registry, exchange, refresh, providers |
| [`@ai-oauth-sdk/cli`](packages/cli) | `ai-oauth-sdk login ...` for the terminal |
| [`@ai-oauth-sdk/node`](packages/node) | Loopback server, file storage, browser launcher |
| [`@ai-oauth-sdk/browser`](packages/browser) | Popup and redirect receivers, web storage |
| [`react`](packages/react) · [`vue`](packages/vue) · [`svelte`](packages/svelte) · [`solid`](packages/solid) | UI bindings over one shared store |
| [`@ai-oauth-sdk/react-native`](packages/react-native) | Deep link and auth session, SecureStore |

Install the umbrella and use subpaths (`ai-oauth-sdk/node`, `ai-oauth-sdk/vue`), or install
only the scoped packages you need.

## Development

```bash
pnpm install
pnpm verify        # lint, typecheck, build, test, exports check
```

Node 24 is pinned in `.nvmrc`. CI runs the gate on Node 22, 24 and 26.

The docs site is a separate project with its own lockfile, so it has its own install step:

```bash
pnpm docs:install
pnpm docs:dev      # http://localhost:5173
pnpm docs:build
pnpm docs:start
```

[`examples/`](examples) has four programs, each against a real provider: a login CLI, an API
caller, a server-side callback handler and a page loaded from a CDN.

```bash
node examples/call-the-api/index.js claude
node examples/cli-login/index.js login openai
node examples/server-callback/index.js          # then open http://localhost:3000
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for what adding a provider takes.

## Downloads

<p align="center">
  <img alt="npm downloads" src="https://shieldcn.dev/chart/npm/ai-oauth-sdk.svg?days=30&amp;logo=false&amp;width=920&amp;icon=ri%3APiFingerprint" />
</p>

<div align="center">
<br />

**MIT** ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) ·
[Disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer)

<sub>An independent project. Not affiliated with or endorsed by OpenAI, Anthropic, Google,
GitHub, Microsoft, xAI, Alibaba or OpenRouter. All trademarks belong to their owners.</sub>

</div>
