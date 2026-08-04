# @ai-oauth-sdk/browser

Browser adapter for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk), covering popup
and full-page redirect sign-in for SPAs.

**[Documentation](https://ai-oauth.themonk.dev/docs/runtimes/browser)**

```bash
npm i @ai-oauth-sdk/browser
```

## Popup

Keeps your page alive. No navigation, no state to rehydrate.

```ts
import { announceCallback, loginWithPopup, postCallbackToOpener } from '@ai-oauth-sdk/browser'

// On your page (must run from a user gesture, or the popup is blocked):
const tokens = await loginWithPopup('openai', { clientId, redirectUri })

// On your redirect page. No opener means either nothing opened this page, or
// the authorization page severed the link — claude.ai does, and the popup is
// still there waiting. announceCallback() broadcasts on your origin instead,
// and resolves true once that popup acknowledges.
if (!postCallbackToOpener()) {
  await announceCallback()
}
```

## Full-page redirect

Immune to popup blockers and works in embedded webviews.

```ts
import { createBrowserAuthClient, startRedirectLogin, handleRedirectCallback } from '@ai-oauth-sdk/browser'

const client = createBrowserAuthClient({ provider: 'openai', clientId })

// Safe to call unconditionally on startup. Returns null when this is not a callback.
const tokens = await handleRedirectCallback(client)

button.onclick = () => startRedirectLogin(client)
```

The PKCE verifier is kept in `sessionStorage` so it survives the navigation but not
the tab. Swap in `localStorageAdapter()` if you want the session to outlive the tab.

## Exports

`popupReceiver`, `postCallbackToOpener`, `announceCallback`, `redirectReceiver`,
`startRedirectLogin`, `handleRedirectCallback`, `createBrowserAuthClient`, `loginWithPopup`,
`sessionStorageAdapter` and `localStorageAdapter`, plus everything from
[`@ai-oauth-sdk/core`](../core).

Storage adapters degrade to in-memory when the browser throws on access (Safari
private mode, cross-origin iframes) rather than breaking sign-in. On a server they
refuse instead, because an in-memory store there is one `Map` shared by every request.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. No provider officially supports these OAuth flows, and any of them may
change without notice. Please read the
[disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer).</sub>
