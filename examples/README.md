# Examples

Every example here talks to a **real provider**. None of them mocks one.

That constraint decides the shape of each: OAuth to these providers happens
against a loopback redirect, which means Node. A browser-only example would need
a client id registered for a web origin, and the published ones are not — see
[browser-cdn](#browser-cdn) below.

| Example | Shows |
|---|---|
| [`call-the-api`](call-the-api) | The whole loop — sign in, then actually call the provider's API |
| [`cli-login`](cli-login) | A provider-login CLI in ~60 lines, using the library directly |
| [`server-callback`](server-callback) | The state-keyed handoff — flow starts on one HTTP request, finishes on another |
| [`browser-cdn`](browser-cdn) | Popup sign-in from a `<script>` tag, no build step |

```bash
pnpm install && pnpm build

node examples/call-the-api/index.js anthropic   # signs in, then lists models
node examples/cli-login/index.js login openai
node examples/server-callback/index.js          # then open http://localhost:3000
```

> Want a CLI rather than an example of one? [`@ai-oauth-sdk/cli`](../packages/cli) is the
> real thing: `npx @ai-oauth-sdk/cli login openai`. `cli-login` exists to show how little
> code building your own takes.

## What each provider's token can actually do

Signing in is not the same as being allowed to call an API, and the difference
is scopes rather than plumbing. `call-the-api` picks an endpoint each token can
genuinely reach:

| Provider | Sample request | Why |
|---|---|---|
| `anthropic`, `xai`, `openrouter`, `qwen` | `GET /models` | the token carries an inference scope |
| `openai` | `GET /models` on the Codex host | the subscription surface, not `api.openai.com` |
| `google` | identity endpoint | Code Assist needs a project handshake before it will answer |

An OAuth token from a ChatGPT sign-in is not an API key, and no scope makes it
one: `api.openai.com` answers it with `403 Missing scopes: api.model.read`. It
does open `chatgpt.com/backend-api/codex`, which is what the descriptor points
at. Issue an API key if you need the REST API itself.

## browser-cdn

Serve the directory over HTTP — WebCrypto needs a secure context, and
`localhost` counts:

```bash
npx serve examples/browser-cdn
```

Then set **your own** registered client id in `index.html`. The values in
`publicClientIds` will not work from a web origin: they are registered for
loopback redirects (`http://localhost:1455/auth/callback`), so a provider
rejects `http://localhost:3000/callback.html` before a consent screen appears.
Google and Microsoft both let you register a web client; do that and the popup
flow works as written.

## Client ids

You name the client id at initialization — no provider defaults to one. Every
built-in provider has a published id to opt into via `publicClientIds`, and
`google` additionally needs the secret in `publicClientSecrets`. Override either
at any time:

```bash
node examples/cli-login/index.js login google --client-id=YOUR_ID --client-secret=YOUR_SECRET
```

→ [**docs/credentials.md**](../docs/credentials.md) for every value and how to
pass it.
