# ai-oauth-sdk

**Sign in with ChatGPT, Claude, Gemini, Grok or Copilot — and get the token back.**

Every AI coding CLI (Codex, Claude Code, Gemini CLI, opencode, Conductor, pi …) ships
its own copy of the same 400 lines: mint a PKCE pair, open a browser, catch the
callback on a loopback port, exchange the code, refresh before expiry. `ai-oauth-sdk` is
that logic, extracted once, with the provider quirks already encoded.

It does one job — **redirect the user, receive the callback, hand you the token for
that request** — and nothing else. No API client, no proxy, no model wrappers.

```bash
npx @ai-oauth-sdk/cli login openai
```

```ts
import { login, publicClientIds } from 'ai-oauth-sdk/node'

// You name the client id, like Passport. `publicClientIds` holds the ones the
// vendors' own CLIs publish; pass your own instead if you registered one.
const tokens = await login('openai', { clientId: publicClientIds.openai })
console.log(tokens.accessToken)
```

---

## Why

The flow is nominally standard OAuth 2.0 + PKCE, but every provider bends it:

| | ChatGPT | Claude | Gemini | Copilot | OpenRouter |
|---|---|---|---|---|---|
| Callback | loopback `:1455` | hosted page, paste `code#state` | loopback, **any** port | none — device code | loopback |
| Token body | form | form (JSON times out) | form + secret | form | **JSON** |
| Returns | `access_token` | `access_token` | `access_token` | `access_token` | **`key`** |
| Redirect param | `redirect_uri` | `redirect_uri` | `redirect_uri` | — | **`callback_url`** |
| Echoes `state` | yes | yes | yes | — | **no** |
| Account id | `id_token`, 3 shapes | `account.uuid` | `sub` claim | — | — |

Encoding those differences is most of the work, and it is exactly the part that gets
copy-pasted and drifts. Here it is a declarative descriptor per provider, with two
escape hatches (`buildAuthParams`, `parseTokenResponse`) for providers that leave the
spec entirely.

---

## Runs anywhere

One core with **zero dependencies**, and a thin adapter per runtime.

| Runtime | Package | Callback strategy |
|---|---|---|
| Terminal | [`@ai-oauth-sdk/cli`](packages/cli) | `npx @ai-oauth-sdk/cli login openai` |
| Node / Bun / Deno | [`@ai-oauth-sdk/node`](packages/node) | local HTTP server on `127.0.0.1` |
| Browser / SPA | [`@ai-oauth-sdk/browser`](packages/browser) | popup, or full-page redirect |
| React | [`@ai-oauth-sdk/react`](packages/react) | `useAuth()` |
| Vue 3 | [`@ai-oauth-sdk/vue`](packages/vue) | `useAuth()` composable |
| Svelte | [`@ai-oauth-sdk/svelte`](packages/svelte) | `$auth` store |
| Solid | [`@ai-oauth-sdk/solid`](packages/solid) | `createAuth()` signals |
| React Native / Expo | [`@ai-oauth-sdk/react-native`](packages/react-native) | deep link or auth session |
| `<script>` tag | [CDN](#cdn) | popup / redirect, `window.AIOAuth` |
| Headless / SSH / CI | any | paste, or RFC 8628 device code |

**React Native works with no crypto polyfill.** Hermes has no `crypto.subtle`, so PKCE
challenges fall back to a bundled pure-JS SHA-256 (verified against WebCrypto and the
FIPS 180-4 vectors). Randomness is the one thing that never degrades — if there is no
CSPRNG, it throws rather than quietly using `Math.random()` for your `state`.

---

## Quickstart

### CLI

```bash
npm i -g @ai-oauth-sdk/cli

ai-oauth-sdk login openai
curl -H "Authorization: Bearer $(ai-oauth-sdk token openai)" \
     https://api.openai.com/v1/models
```

`token` prints the bare token to stdout and nothing else, so `$(...)` is always clean.
To keep it out of your shell history entirely:

```bash
ai-oauth-sdk exec openai -- ./deploy.sh   # token arrives as $AI_OAUTH_SDK_TOKEN
```

### CLI (Node, Bun, Deno) — as a library

```ts
import { login, createNodeAuthClient, publicClientIds } from 'ai-oauth-sdk/node'

// One call: picks a receiver, opens the browser, catches the callback,
// stores tokens in ~/.ai-oauth-sdk/auth.json (0600).
const tokens = await login('anthropic', { clientId: publicClientIds.anthropic })

// Later — refreshes automatically when inside the expiry window.
const client = createNodeAuthClient({ provider: 'anthropic', clientId: publicClientIds.anthropic })
const accessToken = await client.getAccessToken()
```

`login()` picks the right receiver for the machine: a loopback server on a desktop,
and paste-the-code over SSH or with no `DISPLAY`, where a loopback redirect could
never arrive.

### Calling the API

```ts
import { createAuthenticatedFetch } from 'ai-oauth-sdk/core'

const api = createAuthenticatedFetch(client)
const response = await api('/v1/models')   // relative to the provider's apiBaseUrl
```

Attaches a valid bearer token, adds the headers that provider requires, and recovers
from a 401 by refreshing once and replaying the request — which matters because a
token can be revoked well before its nominal expiry, and only the 401 reveals it.

### Browser (popup)

```ts
import { loginWithPopup, postCallbackToOpener } from 'ai-oauth-sdk/browser'

button.onclick = () => loginWithPopup('openai', { clientId, redirectUri })
```

On your redirect page: `postCallbackToOpener()`.

### Browser (full-page redirect)

```ts
import { createBrowserAuthClient, startRedirectLogin, handleRedirectCallback } from 'ai-oauth-sdk/browser'

const client = createBrowserAuthClient({ provider: 'openai', clientId })

// Safe to call unconditionally on startup — returns null when not a callback.
const tokens = await handleRedirectCallback(client)

button.onclick = () => startRedirectLogin(client)
```

The PKCE verifier lives in `sessionStorage` between the two page loads.

### React / Vue / Svelte / Solid

All four wrap the same store, so the API is deliberately parallel.

```tsx
// React
const { login, logout, tokens, isLoading, error } = useAuth({ provider: 'openai', clientId, receiver: popupReceiver() })
```
```vue
<!-- Vue -->
const { login, logout, tokens, isLoading, error } = useAuth({ provider: 'openai', clientId, receiver: popupReceiver() })
```
```svelte
<!-- Svelte -->
const auth = createAuth({ provider: 'openai', clientId, receiver: popupReceiver() })
{#if $auth.tokens} … {/if}
```
```tsx
// Solid
const auth = createAuth({ provider: 'openai', clientId, receiver: popupReceiver() })
<Show when={auth.tokens()}> … </Show>
```

### React Native / Expo

```ts
const client = createAuthClient({
  provider: 'openai',
  clientId,
  storage: secureStoreAdapter(SecureStore),   // Keychain / EncryptedSharedPreferences
})

const tokens = await client.login({
  receiver: authSessionReceiver({ webBrowser: WebBrowser, redirectUri: 'myapp://auth/callback' }),
})
```

Bare RN uses `deepLinkReceiver({ linking: Linking, redirectUri })`, which also handles
the cold-start case where the OS killed your app during consent and delivers the
redirect as the *initial* URL.

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/ai-oauth-sdk/dist/ai-oauth-sdk.global.js"></script>
<script>
  const client = AIOAuth.createAuthClient({ provider: 'openai', clientId, redirectUri })
  const tokens = await client.login({ receiver: AIOAuth.popupReceiver() })
</script>
```

Self-contained, ~13 KB gzipped, no build step.

### Headless — device code

```ts
const tokens = await client.deviceLogin({
  onCode: ({ verificationUri, userCode }) =>
    console.log(`Go to ${verificationUri} and enter ${userCode}`),
})
```

---

## The state-keyed handoff

The part that makes this a library rather than a snippet: **start a flow in one place,
collect the token in another**, correlated by `state`. This is what you need when the
callback lands on a different HTTP request, a different component, or after a full
page reload.

```ts
// 1. Start it — wherever
const { url, state } = await client.createAuthorization()
sendUserTo(url)

// 2. Finish it — wherever the callback actually lands
app.get('/callback', async (req, res) => {
  await client.completeAuthorization({ callbackUrl: req.url })
  res.send('done')
})

// 3. Or block on it — from a third place entirely
const tokens = await client.waitForAuthorization(state, { timeoutMs: 120_000 })
```

`waitForAuthorization` has no race: a result that arrives before anyone waits is
buffered, and multiple waiters on one `state` all get served. Pending records are
persisted through your storage adapter, so the PKCE verifier survives a page
navigation or a process restart.

See [**docs/recipes.md**](docs/recipes.md) for complete callback routes in Hono,
Express, Fastify and Next.js — plus multi-user servers, database-backed storage,
Electron, and wrapping an SDK that expects an API key.

---

## Tokens

```ts
await client.getAccessToken()      // valid token, refreshed if near expiry
await client.authorizationHeader() // "Bearer sk-ant-oat01-…"
await client.isAuthenticated()
await client.refresh()
await client.revoke()              // RFC 7009, where the provider supports it
await client.logout({ revoke: true })
```

Concurrent callers share **one** refresh. Ten parallel API calls waking to an expired
token fire a single request — which matters because providers that rotate refresh
tokens would otherwise invalidate each other's.

Several accounts at once:

```ts
const work = createNodeAuthClient({ provider: 'openai', clientId, accountKey: 'work' })
const personal = createNodeAuthClient({ provider: 'openai', clientId, accountKey: 'personal' })
```

---

## Providers

**You name the client id at initialization** — like Passport. No provider defaults to
one, so nothing ever presents as a vendor's CLI by accident.

```ts
import { createAuthClient, publicClientIds } from 'ai-oauth-sdk/core'

// Opt into the id that vendor's own CLI publishes…
createAuthClient({ provider: 'openai', clientId: publicClientIds.openai })

// …or use one you registered yourself.
createAuthClient({ provider: 'openai', clientId: 'my-registered-client' })
```

| Provider | Flow | Client id |
|---|---|---|
| `openai` | loopback `:1455` | `publicClientIds.openai` |
| `anthropic` | hosted redirect + paste | `publicClientIds.anthropic` |
| `github-copilot` | device code | `publicClientIds['github-copilot']` |
| `qwen` | device code | `publicClientIds.qwen` *(experimental)* |
| `openrouter` | loopback | none — identified by callback URL |
| `google` | loopback, any port | **yours** (needs a `clientSecret` too) |
| `xai` | loopback `:56121` | **yours** *(experimental)* |

Plus a `microsoft({ clientId, tenant })` factory for Entra ID / Azure OpenAI — a
factory rather than a constant because its endpoints are tenant-scoped.

Forget one and you get a `configuration_error` naming exactly what's missing and where
to get it.

**`publicClientIds` values are not secrets.** They're public, PKCE-only clients
extracted from binaries the vendors distribute; OAuth is designed so publishing them
is safe. But using one means *presenting your application as that CLI*, which is why
it's an explicit argument rather than a default. Check the provider's terms before
shipping it in a product.

**Google and xAI aren't in `publicClientIds`.** Google's installed-app client needs a
`clientSecret` as well, and while Google documents those as non-confidential it's
still a credential someone else registered — so this library doesn't carry it.
Register a "Desktop app" client in the Google Cloud console. xAI publishes no client
id at all.

> The `ai-oauth-sdk` CLI is an application rather than a library, so it opts into
> `publicClientIds` for you. `--client-id` overrides it.

### Anything else

```ts
const acme = defineProvider({
  id: 'acme',
  label: 'Acme AI',
  clientId: 'acme-cli',
  authorizationUrl: 'https://auth.acme.ai/authorize',
  tokenUrl: 'https://auth.acme.ai/token',
  scopes: ['openid', 'inference'],
  redirect: { mode: 'loopback', loopbackPort: 0 },
})
```

Or derive one from an OIDC discovery document, so an endpoint move needs no release:

```ts
const provider = await providerFromDiscovery('https://auth.acme.ai', {
  id: 'acme',
  label: 'Acme AI',
  clientId: 'acme-cli',
  redirect: { mode: 'loopback', loopbackPort: 0 },
})
```

The CLI takes the same escape hatch: `--authorize-url` and `--token-url`.

---

## Security notes

- **PKCE (S256) everywhere** it applies, on by default. The verifier is persisted only
  for the flow's lifetime (10 min TTL) and consumed exactly once.
- **`state` is verified** on the callback and the pending record is single-use, so a
  replayed callback cannot replay the exchange. Providers that don't echo `state` must
  opt in via `echoesState: false`, which is documented as unsafe for multi-user servers.
- **Secure randomness is mandatory.** No `Math.random()` fallback, ever.
- **`~/.ai-oauth-sdk/auth.json` is written `0600`** via atomic temp-file rename, so an
  interrupted write can't leave a truncated credential file.
- **The loopback server binds `127.0.0.1`**, never `0.0.0.0`, and serves exactly one
  callback before shutting down.
- **`sessionStorage` is the browser default** — survives the redirect, not the tab.
- **Popup messages are origin-checked**, and `postCallbackToOpener` targets its own
  origin rather than `*`.
- JWTs are decoded but **never signature-verified** — they arrive over TLS straight
  from the token endpoint and are read only for convenience fields. Don't feed
  third-party tokens to `decodeJwtPayload`.

---

## Packages

| Package | Purpose |
|---|---|
| [`ai-oauth-sdk`](packages/ai-oauth-sdk) | Umbrella + CDN build. Start here. |
| [`@ai-oauth-sdk/cli`](packages/cli) | `ai-oauth-sdk login …` for the terminal |
| [`@ai-oauth-sdk/core`](packages/core) | Zero-dep engine: PKCE, registry, exchange, refresh, providers, store |
| [`@ai-oauth-sdk/node`](packages/node) | Loopback server, file storage, browser launcher |
| [`@ai-oauth-sdk/browser`](packages/browser) | Popup + redirect receivers, web storage |
| [`@ai-oauth-sdk/react`](packages/react) · [`vue`](packages/vue) · [`svelte`](packages/svelte) · [`solid`](packages/solid) | UI bindings |
| [`@ai-oauth-sdk/react-native`](packages/react-native) | Deep link + auth session, SecureStore |

Install the umbrella and use subpaths (`ai-oauth-sdk/node`, `ai-oauth-sdk/vue`, …), or install
only the scoped packages you need.

---

## Development

Node 24 (Active LTS) is the pinned development version — see `.nvmrc`.

```bash
pnpm install
pnpm verify      # typecheck && build && test && exports check
```

CI runs the whole gate on Node 22, 24 and 26 — every Node line still receiving
updates. The published packages declare `engines: >=22`; nothing in the code
requires it specifically, so older runtimes will very likely work, they are just
no longer tested.

319 tests. The flow tests drive a real OAuth server that validates PKCE by recomputing
the S256 challenge, so a broken verifier fails the suite rather than only failing in
production. The CLI tests drive real logins end to end through `run()`, with a fake
browser following the printed authorization URL into the loopback listener.

See [`examples/`](examples) for a working CLI, a server-side callback handler, and a
CDN page.

## License

MIT
