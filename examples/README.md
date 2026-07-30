# Examples

Every package has one. The four framework demos are runnable in a single command
and complete a real sign-in.

## Framework bindings

| Example | Shows |
|---|---|
| [`react`](react) | `useAuth()` from [`@ai-oauth-sdk/react`](../packages/react) |
| [`vue`](vue) | `useAuth()` composable from [`@ai-oauth-sdk/vue`](../packages/vue) |
| [`svelte`](svelte) | `$auth` store from [`@ai-oauth-sdk/svelte`](../packages/svelte) |
| [`solid`](solid) | `createAuth()` signals from [`@ai-oauth-sdk/solid`](../packages/solid) |

```bash
pnpm install
pnpm --filter @ai-oauth-sdk-example/react dev     # or vue / svelte / solid
```

Click **Sign in** → a popup shows a consent screen → approve → you're signed in
with a refreshable token. No accounts, no API keys, no network.

That works because Vite serves a mock provider alongside the app
([`shared/mock-provider.ts`](shared/mock-provider.ts)). The *flow* is real —
PKCE with S256, and the mock recomputes the challenge from the verifier and
rejects a mismatch — only the provider is pretend. Each example's README shows
the two-line change to point it at a real one.

> Real providers can't be used directly here: the ids in `publicClientIds` are
> registered for loopback redirects, not web origins, so they'd reject
> `http://localhost:5173/callback.html` outright.

## Scenarios

| Example | Shows |
|---|---|
| [`call-the-api`](call-the-api) | The whole loop — sign in, then actually call the provider's API |
| [`cli-login`](cli-login) | A provider-login CLI in ~60 lines, using the library directly |
| [`server-callback`](server-callback) | The state-keyed handoff — flow starts on one HTTP request, finishes on another |
| [`browser-cdn`](browser-cdn) | Popup sign-in from a `<script>` tag, no build step |

```bash
pnpm install && pnpm build

node examples/call-the-api/index.js openai    # signs in, then lists models
node examples/cli-login/index.js login openai
node examples/server-callback/index.js        # then open http://localhost:3000
```

> Want a CLI rather than an example of one? [`@ai-oauth-sdk/cli`](../packages/cli) is the
> real thing: `npx @ai-oauth-sdk/cli login openai`. `cli-login` exists to show how little
> code building your own takes.

For `browser-cdn`, serve the directory over HTTP (WebCrypto needs a secure context;
`localhost` counts) and set your own registered web client id in `index.html`:

```bash
npx serve examples/browser-cdn
```

## Client ids

You name the client id at initialization — no provider defaults to one. `openai`,
`anthropic`, `github-copilot` and `qwen` have published ids you can opt into via
`publicClientIds`; `google` and `xai` need credentials you register yourself:

```bash
node examples/cli-login/index.js login xai --client-id=YOUR_CLIENT_ID
```
