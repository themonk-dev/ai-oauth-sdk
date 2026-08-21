---
'@ai-oauth-sdk/browser': patch
---

Stop `localStorageAdapter()` and `sessionStorageAdapter()` handing a Cloudflare Worker a token store shared by every request it serves.

Both adapters refuse to invent an in-memory store where there is no browser storage, because on a server `memoryStorage()` is a plain `Map` scoped to the module rather than the request. A Web Worker was the one exception: no web storage and no `window`, exactly like a server, but still one user's browser, and the adapters told the two apart by asking `'WorkerGlobalScope' in globalThis`.

workerd answers yes to that question. Cloudflare Workers and Pages Functions, `@cloudflare/next-on-pages`, `adapter-cloudflare` and Nitro's `cloudflare_module` therefore took the worker branch and got the in-memory store, in an isolate that serves many requests: one user signing in wrote their tokens into a `Map` the next request read back. In a worker built from the previous release, three requests on three connections, request one signs in and requests two and three both come back authenticated as request one's user.

The check is now a conjunction, and every part of it has to hold before an in-memory store is handed back: `globalThis` really is an instance of `WorkerGlobalScope`, `WorkerNavigator` is exposed, `location` exists, and the user agent is not `Cloudflare-Workers`. The last two are things the HTML specification requires of a worker global and workerd does not implement, so they are what carries the check rather than the Cloudflare-specific deny.

It fails closed: a runtime that cannot be positively identified as a browser worker now gets the same refusal server-side rendering gets, with the message naming the risk. Real dedicated workers and service workers are unaffected — the conjunction was measured against Chromium, where it holds in both. If you are in some other worker-like runtime that is genuinely one user, pass `storage:` explicitly, with `memoryStorage()` from `@ai-oauth-sdk/core` if that is what you want.

**This is a behaviour change** for anything deployed on workerd that read or wrote tokens through these adapters. That code was reading and writing a store shared with every other user of the isolate, and now fails loudly instead. Give it a real per-request store — a cookie, KV, Durable Object or D1 behind the three-method `AuthStorage` interface.
