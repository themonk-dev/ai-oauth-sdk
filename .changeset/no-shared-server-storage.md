---
'@ai-oauth-sdk/browser': patch
---

Stop `localStorageAdapter()` and `sessionStorageAdapter()` silently becoming a token store shared between users on the server.

Both adapters treated "storage is unavailable" as one case. It is two. Safari private mode and sandboxed iframes *throw* on access, and degrading those to an in-memory store is right — a sign-in should not crash there. But on a server the globals are simply absent, `typeof` comes back `'undefined'` with no exception, and the same branch handed back `memoryStorage()`: a plain `Map`, scoped to the module rather than the request, shared by every request the process serves.

This package is imported from `"use client"` files, and frameworks evaluate those during server-side rendering. An audit of a real app found that store already constructed on the server, empty only because every call site happened to sit inside an effect. Moving one into a render body would have pooled every user's tokens into one `Map`, with nothing warning anybody.

A Web Worker looks the same from the outside — no web storage, no `window` — and gets the in-memory store rather than the refusal, since nothing in a worker is shared between users. The adapters tell the two apart by `WorkerGlobalScope`, which exists only inside one.

Constructing an adapter without browser storage is still harmless, because `createBrowserAuthClient()` and `useAuth({ storage: sessionStorageAdapter() })` are called from render bodies that SSR runs, and throwing there would break server rendering for an app that merely imports the SDK. Reading or writing through one now rejects with an error naming the risk.

**This is a behaviour change** for any code that reads or writes tokens *during* a server render, which previously succeeded silently against the shared map and now fails loudly. That is the point of the change, but it is the one thing that could surprise an existing consumer. If an in-memory store on the server is genuinely what you want, ask for it explicitly with `memoryStorage()` from `@ai-oauth-sdk/core`.
