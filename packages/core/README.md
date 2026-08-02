# @ai-oauth-sdk/core

Zero-dependency, framework-agnostic OAuth 2.0 + PKCE engine for AI provider sign-in.

**[Documentation](https://ai-oauth.themonk.dev/docs/reference/auth-client)**

This is the part that runs everywhere. No Node APIs, no DOM APIs, no dependencies. Pair it with a
runtime adapter ([`@ai-oauth-sdk/node`](../node), [`@ai-oauth-sdk/browser`](../browser),
[`@ai-oauth-sdk/react-native`](../react-native)) or drive it yourself.

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
// Send the user to `url`. When the callback lands:
const tokens = await client.completeAuthorization({ code, state })
```

## What's in here

**Providers.** Descriptors for `openai`, `anthropic`, `google` and `xai`, plus
`defineProvider()` and `providerFromDiscovery()` for your own.

**PKCE.** `createPkce()`, with a pure-JS SHA-256 fallback for runtimes without
`crypto.subtle` such as React Native. Secure randomness is required, never faked.

**`AuthorizationRegistry`.** Tracks in-flight logins by `state`, so a flow can be started and
completed in different places. Results are buffered, so there is no race between finishing a login
and waiting for it.

**Token handling.** `exchangeCode()`, `refreshTokens()`, `isExpired()`, and deduplicated
auto-refresh on the client.

**Receivers.** `manualReceiver()` for paste, which works anywhere, and the RFC 8628 device code
flow.

**Storage.** `memoryStorage()`, `fromSyncStorage()`, `prefixedStorage()`.

## Using the token

`createAuthenticatedFetch(client)` returns a `fetch` that attaches a valid token, refreshes before
expiry, adds whatever headers the provider needs, and retries once on a 401. Hand it to any SDK
that takes a `fetch`. See [Using the token](https://ai-oauth.themonk.dev/docs/recipes/ai-sdk).

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. No provider officially supports these OAuth flows, and any of them may
change without notice. Please read the
[disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer).</sub>
