# @ai-oauth-sdk/node

Node, Bun and Deno adapter for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk). This
is the loopback callback server that CLI sign-in needs.

**[Documentation](https://ai-oauth.themonk.dev/docs/runtimes/node)**

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

| Export | Does |
| --- | --- |
| `login(provider, options?)` | The whole flow in one call. |
| `createNodeAuthClient(options)` | A client preconfigured with file storage. Use `getAccessToken()` for transparent refresh. |
| `loopbackReceiver(options?)` | Binds `127.0.0.1`, serves one callback and a styled success page, then shuts down. Reports port collisions clearly. |
| `promptReceiver(options?)` | Prints the URL and reads the pasted result from stdin. The right choice over SSH. |
| `defaultReceiver(provider)` | Picks between the two based on `DISPLAY`, `SSH_TTY` and the provider's redirect mode. |
| `fileStorage(options?)` | Atomic `0600` JSON storage, serialised against concurrent writes. Honours `AI_OAUTH_SDK_HOME`. |
| `openBrowser(url)`, `canOpenBrowser()` | Dependency-free browser launching. |

Everything from [`@ai-oauth-sdk/core`](../core) is re-exported.

Set `AI_OAUTH_SDK_NO_BROWSER=1` and nothing is launched, which is what you want in a test suite or
a CI job that drives a login end to end.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. No provider officially supports these OAuth flows, and any of them may
change without notice. Please read the
[disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer).</sub>
