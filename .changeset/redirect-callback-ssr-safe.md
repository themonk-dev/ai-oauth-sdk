---
'@ai-oauth-sdk/browser': patch
---

`handleRedirectCallback()` returns `null` on a server instead of throwing.

It is documented as safe to call unconditionally at startup, and the top-level `await handleRedirectCallback(client)` the quick start shows is exactly what an app puts in a module that its framework also runs on the server. There it read `window.location.href` before anything guarded for a window, and threw a bare `ReferenceError` out of the render — an SDK import taking down a page that had no callback to complete. The `typeof window` test further down never helped: it sat on a branch only reached in the case that had already thrown.

There is no address bar to read on a server, so there is nothing to complete: the call now returns `null`. Passing an explicit `url` is unaffected and still completes the login wherever it runs — that URL is a string the caller already has, which is how a framework hands over its own request URL, and the address-bar clean-up was already skipped for it.
