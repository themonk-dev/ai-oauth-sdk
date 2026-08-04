---
'@ai-oauth-sdk/browser': minor
'@ai-oauth-sdk/core': minor
---

Fix popup sign-in against providers whose authorization page severs the opener, which today fails Claude on every attempt.

`claude.ai` serves its authorization page with an enforced `Cross-Origin-Opener-Policy: same-origin` — not the `-report-only` variant `accounts.google.com` sends, which severs nothing. The browser therefore moves the popup into its own browsing-context group: `window.opener` inside it becomes `null` permanently, including after it navigates back to your own redirect page, and your handle to the popup reports `closed === true` while the popup is still on screen.

`popupReceiver` polled `closed` to notice a user giving up, so it failed a perfectly good sign-in about a second after the popup opened, reporting "The sign-in window was closed before completing" when nothing had been closed and nothing cancelled.

`popupReceiver` now reads the new `authPage.seversOpener` fact on the provider descriptor and skips that poll for such a provider. Where the opener stays intact the poll still runs, because there it is the only signal a closed window leaves behind. It also listens on a `BroadcastChannel` alongside `postMessage`, which does not go through the opener relationship at all and so survives the swap.

Redirect pages should fall back to the new `announceCallback()` when `postCallbackToOpener()` reports no opener:

```html
<script type="module">
  import { postCallbackToOpener, announceCallback } from '@ai-oauth-sdk/browser'
  if (!postCallbackToOpener()) {
    await announceCallback()
  }
</script>
```

`announceCallback()` resolves `true` once a waiting receiver acknowledges, and closes its own window on the way, because your handle to a severed popup may not be able to. It resolves `false` once the timeout passes with nothing acknowledging, which usually means nobody was waiting — someone opened the redirect URL directly — though a receiver on a busy main thread can miss the deadline for a callback it goes on to accept. `postCallbackToOpener()` is unchanged in both signature and behaviour.

A callback heard on the channel is matched to the attempt that presented it by comparing `state`, read through the provider's own `parseCallback` so the receiver and the client always agree on what the `state` is. A `BroadcastChannel` reaches *every* context on the origin, where `postMessage` reaches only the opener: every receiver hears every broadcast, so without the comparison two tabs of the same app signing in at once would each take the other's callback. The `postMessage` path is unfiltered, as it was — a message that arrives there was minted for the window it arrived at.

A provider that does not echo `state` (OpenRouter) leaves nothing to compare, so two tabs signing in against one of those at the same time can still collide. Nor is there any way to notice a user closing the popup where the opener was severed: pass `timeoutMs` to `login()` for such a provider, or the promise waits as long as the page lives.

`ProviderConfig.authPage.seversOpener` and `RedirectSpec.acceptsHttpsRedirect` are new optional descriptor fields. Both are additive; existing providers and any `defineProvider()` call keep working untouched, and nothing in the CLI or Node paths behaves differently.
