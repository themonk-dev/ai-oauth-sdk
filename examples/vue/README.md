# @ai-oauth-sdk/vue example

`useAuth()` wired into a component, with a sign-in that actually completes.

```bash
pnpm install
pnpm --filter @ai-oauth-sdk-example/vue dev
```

Open the printed URL and click **Sign in**. A popup shows a consent screen, you
approve, and the app flips to signed-in with a token you can refresh.

## It's a real flow, not a stub

There is no network call to a real provider — Vite serves a mock one at
`/mock/authorize` and `/mock/token` (see
[`examples/shared/mock-provider.ts`](../shared/mock-provider.ts)). But the flow
itself is genuine: PKCE with S256, and the mock provider recomputes the challenge
from the verifier and **rejects a mismatch**. Break the crypto and this example
stops working.

Why not point at a real provider? The ids in `publicClientIds` are registered for
*loopback* redirects, not web origins, so ChatGPT or Claude would reject
`http://localhost:5173/callback.html` before you saw anything.

## Pointing it at a real provider

Register your own OAuth client with `http://localhost:5173/callback.html` as a
redirect URI, then in [`src/App.vue`](src/App.vue) swap the descriptor for a
provider id:

```ts
useAuth({
  provider: 'openai',
  clientId: 'your-registered-client-id',
  redirectUri: `${location.origin}/callback.html`,
  receiver: popupReceiver({ redirectUri: `${location.origin}/callback.html` }),
})
```

## Worth noticing

- **`login()` is called straight from the click handler.** Popups opened outside a
  user gesture get blocked; the receiver reports that as
  `unsupported_runtime` with advice rather than hanging.
- **Closing the popup is not an error.** `error` stays empty — cancelling is a
  user action, so there is nothing to apologise for in the UI.
- **[`callback.html`](callback.html) is a Vite entry, not a `public/` file.**
  Files in `public/` are served unprocessed, so its bare import of
  `@ai-oauth-sdk/browser` would never resolve.
