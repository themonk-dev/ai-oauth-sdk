
<div align="center">

![AI OAuth SDK](https://shieldcn.dev/header/dots.svg?title=AI+OAuth+SDK&subtitle=Sign+in+with+ChatGPT%2C+Claude%2C+Gemini%2C+Grok%2C+or+Copilot+from+a+single+SDK.&logo=ri%3APiFingerprintLight&size=wide&mode=dark&brand=themonk-dev)

<p>
<a href="https://www.npmjs.com/package/ai-oauth-sdk"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/npm/v/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="npm" src="https://www.shieldcn.dev/npm/v/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://github.com/themonk-dev/ai-oauth-sdk/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/ci/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="CI" src="https://www.shieldcn.dev/github/ci/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://github.com/themonk-dev/ai-oauth-sdk/stargazers"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/stars/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="GitHub Stars" src="https://www.shieldcn.dev/github/stars/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://github.com/themonk-dev/ai-oauth-sdk/graphs/contributors"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/contributors/themonk-dev/ai-oauth-sdk.svg?theme=emerald&amp;size=xs&amp;mode=dark"><img alt="Contributors" src="https://www.shieldcn.dev/github/contributors/themonk-dev/ai-oauth-sdk.svg?theme=emerald&amp;size=xs&amp;mode=light"></picture></a>
<a href="https://github.com/themonk-dev/ai-oauth-sdk/commits/main"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/last-commit/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=dark"><img alt="Last commit" src="https://www.shieldcn.dev/github/last-commit/themonk-dev/ai-oauth-sdk.svg?variant=secondary&amp;size=xs&amp;mode=light"></picture></a>
<a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/license/themonk-dev/ai-oauth-sdk.svg?variant=ghost&amp;size=xs&amp;mode=dark"><img alt="License" src="https://www.shieldcn.dev/github/license/themonk-dev/ai-oauth-sdk.svg?variant=ghost&amp;size=xs&amp;mode=light"></picture></a>
</p>

**[Documentation](https://ai-oauth-sdk.pages.dev)** ·
[Quickstart](https://ai-oauth-sdk.pages.dev/quick-start) ·
[Providers](https://ai-oauth-sdk.pages.dev/providers) ·
[Recipes](https://ai-oauth-sdk.pages.dev/recipes) ·
[Reference](https://ai-oauth-sdk.pages.dev/reference/auth-client) ·
[Security](https://ai-oauth-sdk.pages.dev/resources/security) ·
[Disclaimer](https://ai-oauth-sdk.pages.dev/resources/disclaimer)

</div>

<br />

Every AI coding CLI (Codex, Claude Code, Gemini CLI, opencode) ships its own copy of the
same 400 lines: mint a PKCE pair, open a browser, catch the callback on a loopback port,
exchange the code, refresh before expiry.

This is that logic, extracted once, with the provider quirks already encoded. It does one
job. **Redirect the user, receive the callback, hand you the token.** There is no API
client here, no proxy, and no model wrappers.

```bash
npx @ai-oauth-sdk/cli login openai
```

```ts
import { login, publicClientIds } from 'ai-oauth-sdk/node'

// You name the client id, the way Passport does. Nothing presents as a
// vendor's CLI by accident.
const { accessToken } = await login('openai', { clientId: publicClientIds.openai })
```

---

## Why

Nominally it is standard OAuth 2.0 with PKCE. In practice every provider bends it:

| | ChatGPT | Claude | Gemini | Copilot | OpenRouter |
|---|---|---|---|---|---|
| **Callback** | loopback `:1455` | hosted, paste `code#state` | loopback, any port | none, device code | loopback |
| **Token body** | form | form *(JSON times out)* | form plus secret | form | **JSON** |
| **Returns** | `access_token` | `access_token` | `access_token` | `access_token` | **`key`** |
| **Echoes `state`** | yes | yes | yes | not applicable | **no** |

Encoding those differences is most of the work, and it is exactly the part that gets
copy-pasted and drifts. Here it is a declarative descriptor per provider, with two escape
hatches for the ones that leave the spec entirely.

---

## Runs anywhere

One core with **zero dependencies**, and a thin adapter per runtime.

| Runtime | Package | Callback strategy |
|---|---|---|
| Terminal | [`@ai-oauth-sdk/cli`](packages/cli) | `npx @ai-oauth-sdk/cli login openai` |
| Node, Bun, Deno | [`@ai-oauth-sdk/node`](packages/node) | local server on `127.0.0.1` |
| Browser, SPA | [`@ai-oauth-sdk/browser`](packages/browser) | popup, or full-page redirect |
| React, Vue, Svelte, Solid | [`react`](packages/react) [`vue`](packages/vue) [`svelte`](packages/svelte) [`solid`](packages/solid) | `useAuth()`, `$auth`, signals |
| React Native, Expo | [`@ai-oauth-sdk/react-native`](packages/react-native) | deep link or auth session |
| `<script>` tag | CDN bundle | popup or redirect, `window.AIOAuth` |
| Headless, SSH, CI | any | paste, or RFC 8628 device code |

> [!NOTE]
> **React Native needs no polyfills.** Hermes has no `crypto.subtle`, so PKCE falls back
> to a bundled pure-JS SHA-256. The OAuth path also never touches `URL.searchParams` or
> the `URLSearchParams` constructor, both of which are unusable on bare RN. Randomness is
> the one thing that never degrades: with no CSPRNG it throws rather than quietly using
> `Math.random()` for your `state`.

Full setup for each runtime is on the
[Quickstart](https://ai-oauth-sdk.pages.dev/quick-start).

---

## Providers

**You name the client id at initialization**, like Passport. No provider defaults to one.

```ts
createAuthClient({ provider: 'openai', clientId: publicClientIds.openai })  // that vendor's CLI
createAuthClient({ provider: 'openai', clientId: 'my-registered-client' })  // or your own
```

| Provider | Flow | Client id |
|---|---|---|
| `openai` | loopback `:1455` | `publicClientIds.openai` |
| `anthropic` | loopback, any port | `publicClientIds.anthropic` |
| `github-copilot` | device code | `publicClientIds['github-copilot']` |
| `qwen` | device code | `publicClientIds.qwen` *(experimental)* |
| `openrouter` | loopback | none, identified by callback URL |
| `google` | loopback, any port | `publicClientIds.google` plus `publicClientSecrets.google` |
| `xai` | loopback `:56121` | `publicClientIds.xai` *(experimental)* |

Plus `microsoft({ clientId, tenant })` for Entra ID, a factory rather than a constant
because its endpoints are tenant-scoped.

> [!IMPORTANT]
> `publicClientIds` values **are not secrets**. They are public PKCE-only clients the
> vendors ship in their own binaries. But using one means *presenting your application as
> that CLI*, which is why it is an explicit argument rather than a default. Check the
> provider's terms before shipping it in a product.

> [!WARNING]
> **This project is built for fun and for learning, and none of these providers supports
> third-party OAuth clients.** Everything here was derived from the vendors' own
> open-source CLIs and the RFCs they implement, so endpoints and client ids can change or
> stop working at any time. Several providers also restrict what you may do with a
> credential issued to their own CLI, so getting a token is not the same as being allowed
> to use it. Read their terms, and read the
> [disclaimer](https://ai-oauth-sdk.pages.dev/resources/disclaimer). Use it at your own
> discretion.

Any other OAuth 2.0 provider works through
[`defineProvider()` or `providerFromDiscovery()`](https://ai-oauth-sdk.pages.dev/providers/custom).

---

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

---

## Security

PKCE with S256 everywhere it applies. `state` verified in constant time on every callback,
and a callback carrying **no** `state` is rejected rather than waved through. Secure
randomness is mandatory, with no `Math.random()` fallback. Credentials are scrubbed from
error messages before they reach your logs. The loopback server binds `127.0.0.1`, answers
`GET` and `HEAD` only, and serves exactly one callback.

The full threat model, the storage tradeoffs and how to report a vulnerability are in
[SECURITY.md](SECURITY.md).

---

## Development

```bash
pnpm install
pnpm verify      # lint, typecheck, build, test, exports check
```

Node 24 is pinned in `.nvmrc`; `nvm use` picks it up. CI runs the gate on Node 22, 24 and
26. **434 tests**, where the flow tests drive a real OAuth server that validates PKCE by
recomputing the S256 challenge, so a broken verifier fails the suite rather than only
failing in production.

The documentation site lives in [`docs/`](docs) and is a separate project with its own
lockfile, deliberately outside the pnpm workspace. It has its own install step, since a
`pnpm install` at the root does not reach it:

```bash
pnpm docs:install
pnpm docs:dev      # hot reload, http://localhost:5173
pnpm docs:build    # static output in docs/build/client
pnpm docs:start    # serve that output
```

### Examples

Every example talks to a real provider. None of them mocks one.

| Example | Shows |
|---|---|
| [`call-the-api`](examples/call-the-api) | The whole loop: sign in, then actually call the provider's API |
| [`cli-login`](examples/cli-login) | A provider-login CLI in about 60 lines, using the library directly |
| [`server-callback`](examples/server-callback) | The state-keyed handoff, where the flow starts on one HTTP request and finishes on another |
| [`browser-cdn`](examples/browser-cdn) | Popup sign-in from a `<script>` tag, no build step |

```bash
pnpm install && pnpm build

node examples/call-the-api/index.js anthropic   # signs in, then lists models
node examples/cli-login/index.js login openai
node examples/server-callback/index.js          # then open http://localhost:3000
```

What adding a provider takes, and the rest of the contributor notes, are in
[CONTRIBUTING.md](CONTRIBUTING.md).

<div align="center">
<br />

**MIT** ·
[Contributing](CONTRIBUTING.md) ·
[Recipes](https://ai-oauth-sdk.pages.dev/recipes) ·
[Security](SECURITY.md) ·
[Disclaimer](https://ai-oauth-sdk.pages.dev/resources/disclaimer)

<sub>An independent project. Not affiliated with or endorsed by OpenAI, Anthropic, Google,
GitHub, Microsoft, xAI, Alibaba or OpenRouter. All trademarks belong to their owners.</sub>

</div>
