# @ai-oauth-sdk/browser

Browser adapter for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk) — popup and
full-page redirect sign-in for SPAs.

```bash
npm i @ai-oauth-sdk/browser
```

## Popup

Keeps your page alive — no navigation, no state to rehydrate.

```ts
import { loginWithPopup, postCallbackToOpener } from '@ai-oauth-sdk/browser'

// On your page (must run from a user gesture, or the popup is blocked):
const tokens = await loginWithPopup('openai', { clientId, redirectUri })

// On your redirect page:
postCallbackToOpener()
```

## Full-page redirect

Immune to popup blockers and works in embedded webviews.

```ts
import { createBrowserAuthClient, startRedirectLogin, handleRedirectCallback } from '@ai-oauth-sdk/browser'

const client = createBrowserAuthClient({ provider: 'openai', clientId })

// Safe to call unconditionally on startup — returns null when not a callback.
const tokens = await handleRedirectCallback(client)

button.onclick = () => startRedirectLogin(client)
```

The PKCE verifier is kept in `sessionStorage` so it survives the navigation but not
the tab. Swap in `localStorageAdapter()` if you want the session to outlive the tab.

## Exports

`popupReceiver` · `postCallbackToOpener` · `redirectReceiver` · `startRedirectLogin` ·
`handleRedirectCallback` · `createBrowserAuthClient` · `loginWithPopup` ·
`sessionStorageAdapter` · `localStorageAdapter`, plus everything from
[`@ai-oauth-sdk/core`](../core).

Storage adapters degrade to in-memory when the browser throws on access (Safari
private mode, cross-origin iframes) rather than breaking sign-in.

## License

MIT
