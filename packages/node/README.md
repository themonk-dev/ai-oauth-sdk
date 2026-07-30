# @ai-oauth-sdk/node

Node / Bun / Deno adapter for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk) —
the loopback callback server that CLI sign-in needs.

```bash
npm i @ai-oauth-sdk/node
```

```ts
import { login } from '@ai-oauth-sdk/node'

const tokens = await login('openai')
```

That single call mints a PKCE pair, binds a local HTTP server, opens the browser,
catches the redirect, exchanges the code, and writes the tokens to
`~/.ai-oauth-sdk/auth.json` with `0600` permissions.

## Exports

- **`login(provider, options?)`** — the whole flow in one call.
- **`createNodeAuthClient(options)`** — a client preconfigured with file storage; use
  `getAccessToken()` for transparent refresh.
- **`loopbackReceiver(options?)`** — binds `127.0.0.1`, serves one callback and a
  styled success page, then shuts down. Reports port collisions clearly.
- **`promptReceiver(options?)`** — prints the URL and reads the pasted result from
  stdin. The right choice over SSH.
- **`defaultReceiver(provider)`** — picks between the two based on `DISPLAY`,
  `SSH_TTY`, and the provider's redirect mode.
- **`fileStorage(options?)`** — atomic `0600` JSON storage, serialised against
  concurrent writes. Honours `AI_OAUTH_SDK_HOME`.
- **`openBrowser(url)` / `canOpenBrowser()`** — dependency-free browser launching.

Everything from [`@ai-oauth-sdk/core`](../core) is re-exported.

## License

MIT
