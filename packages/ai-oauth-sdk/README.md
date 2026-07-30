# ai-oauth-sdk

**Sign in with ChatGPT, Claude, Gemini or Grok — and get the token back.**

The umbrella package: one install, one subpath per runtime, plus a CDN build.

```bash
npm i ai-oauth-sdk
```

```ts
import { login } from 'ai-oauth-sdk/node'          // CLI
import { loginWithPopup } from 'ai-oauth-sdk/browser' // SPA
import { useAuth } from 'ai-oauth-sdk/react'          // React
import { deepLinkReceiver } from 'ai-oauth-sdk/react-native'
import { createAuthClient } from 'ai-oauth-sdk/core'  // engine only
```

Bare `import … from 'ai-oauth-sdk'` resolves per runtime — the Node build under Node, the
browser build in bundlers and browsers, the native build under React Native.

## CDN

```html
<script src="https://cdn.jsdelivr.net/npm/ai-oauth-sdk/dist/ai-oauth-sdk.global.js"></script>
<script>
  const client = AIOAuth.createAuthClient({ provider: 'openai', clientId, redirectUri })
  const tokens = await client.login({ receiver: AIOAuth.popupReceiver() })
</script>
```

Self-contained, ~10 KB gzipped, no build step.

Full documentation: [github.com/themonk-dev/ai-oauth-sdk](https://github.com/themonk-dev/ai-oauth-sdk)

## License

MIT
