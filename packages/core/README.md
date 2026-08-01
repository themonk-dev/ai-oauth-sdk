# @ai-oauth-sdk/core

Zero-dependency, framework-agnostic OAuth 2.0 + PKCE engine for AI provider sign-in.

**[Documentation](https://ai-oauth-sdk.themonk.dev/docs/reference/auth-client)**

This is the part that runs everywhere — no Node APIs, no DOM APIs, no dependencies.
Pair it with a runtime adapter ([`@ai-oauth-sdk/node`](../node),
[`@ai-oauth-sdk/browser`](../browser), [`@ai-oauth-sdk/react-native`](../react-native)) or drive
it yourself.

```bash
npm i @ai-oauth-sdk/core
```

```ts
import { createAuthClient } from '@ai-oauth-sdk/core'

const client = createAuthClient({
  provider: 'openai',
  redirectUri: 'https://yourapp.com/callback',
})

const { url, state } = await client.createAuthorization()
// …send the user to `url`, then when the callback lands:
const tokens = await client.completeAuthorization({ code, state })
```

## What's in here

- **Providers** — `openai`, `anthropic`, `google`, `xai` descriptors, plus
  `defineProvider()` and `providerFromDiscovery()` for your own.
- **PKCE** — `createPkce()`, with a pure-JS SHA-256 fallback for runtimes without
  `crypto.subtle` (React Native). Secure randomness is required, never faked.
- **`AuthorizationRegistry`** — tracks in-flight logins by `state`, so a flow can be
  started and completed in different places. Buffers results so there's no race.
- **Token handling** — `exchangeCode()`, `refreshTokens()`, `isExpired()`, and
  deduplicated auto-refresh on the client.
- **Receivers** — `manualReceiver()` (paste, works anywhere) and RFC 8628 device code.
- **Storage** — `memoryStorage()`, `fromSyncStorage()`, `prefixedStorage()`.

Full documentation: [github.com/themonk-dev/ai-oauth-sdk](https://github.com/themonk-dev/ai-oauth-sdk)

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. These OAuth flows are not officially supported by any provider and may
change without notice — see the
[disclaimer](https://ai-oauth-sdk.themonk.dev/docs/resources/disclaimer).</sub>
