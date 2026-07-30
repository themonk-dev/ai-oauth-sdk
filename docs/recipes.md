# Recipes

Patterns for wiring `ai-oauth-sdk` into a real application. Each one is complete —
copy it and change the names.

- [A callback route on your own server](#a-callback-route-on-your-own-server)
- [Next.js App Router](#nextjs-app-router)
- [A multi-user server](#a-multi-user-server)
- [Database-backed storage](#database-backed-storage)
- [Electron](#electron)
- [Wrapping an SDK that expects an API key](#wrapping-an-sdk-that-expects-an-api-key)
- [Testing your integration](#testing-your-integration)

---

## A callback route on your own server

The flow starts on one request and finishes on another, so nothing can be held in
a closure. `state` is the only thing tying them together — which is exactly what
the registry is for.

The framework barely matters; these all do the same three things.

### Hono

```ts
import { Hono } from 'hono'
import { createAuthClient, publicClientIds } from '@ai-oauth-sdk/core'

const client = createAuthClient({
  provider: 'openai',
  // You name the credential, like Passport. `publicClientIds.openai` is the one
  // OpenAI's own Codex CLI publishes; pass your own registered id instead if you
  // don't want to present as that CLI.
  clientId: publicClientIds.openai,
  redirectUri: 'https://yourapp.com/auth/callback',
  storage: redisStorage(),          // see "Database-backed storage" below
})

const app = new Hono()

app.get('/auth/login', async (c) => {
  const { url } = await client.createAuthorization()
  return c.redirect(url)
})

app.get('/auth/callback', async (c) => {
  const tokens = await client.completeAuthorization({ callbackUrl: c.req.url })
  return c.json({ signedInAs: tokens.email })
})
```

### Express

```ts
app.get('/auth/login', async (req, res) => {
  const { url } = await client.createAuthorization()
  res.redirect(url)
})

app.get('/auth/callback', async (req, res) => {
  // Express gives you a path-relative URL; the parser handles either form.
  const tokens = await client.completeAuthorization({ callbackUrl: req.originalUrl })
  res.json({ signedInAs: tokens.email })
})
```

### Fastify

```ts
fastify.get('/auth/callback', async (request) => {
  const tokens = await client.completeAuthorization({ callbackUrl: request.url })
  return { signedInAs: tokens.email }
})
```

**Errors.** A user who clicks "Deny" comes back with `?error=access_denied`, which
`completeAuthorization` turns into an `OAuthError`. Handle it rather than letting it
500:

```ts
import { isOAuthError } from '@ai-oauth-sdk/core'

try {
  await client.completeAuthorization({ callbackUrl: req.url })
} catch (error) {
  if (isOAuthError(error) && error.code === 'authorization_denied') {
    return res.status(400).send('You declined the sign-in request.')
  }
  if (isOAuthError(error) && error.code === 'state_expired') {
    return res.redirect('/auth/login')   // took too long; just start over
  }
  throw error
}
```

---

## Next.js App Router

```ts
// app/auth/login/route.ts
import { redirect } from 'next/navigation'
import { authClient } from '@/lib/auth'

export async function GET() {
  const { url } = await authClient.createAuthorization()
  redirect(url)
}
```

```ts
// app/auth/callback/route.ts
import { NextResponse, type NextRequest } from 'next/server'
import { isOAuthError } from '@ai-oauth-sdk/core'
import { authClient } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const tokens = await authClient.completeAuthorization({ callbackUrl: request.url })
    return NextResponse.json({ signedInAs: tokens.email })
  } catch (error) {
    if (isOAuthError(error)) {
      return NextResponse.json({ error: error.code }, { status: 400 })
    }
    throw error
  }
}
```

**Use a shared store, not memory.** Serverless functions do not share process memory,
so the pending record written by `/auth/login` must be readable by `/auth/callback` —
which may be a different instance entirely. `memoryStorage()` will appear to work in
dev and fail in production.

---

## A multi-user server

Everything above assumes one account. For many users, give each their own client via
`accountKey`, and namespace the storage so pending flows can't collide:

```ts
import { createAuthClient, prefixedStorage, publicClientIds } from '@ai-oauth-sdk/core'

function clientFor(userId: string) {
  return createAuthClient({
    provider: 'openai',
    clientId: publicClientIds.openai,
    redirectUri: 'https://yourapp.com/auth/callback',
    accountKey: userId,
    storage: prefixedStorage(sharedStorage, `user:${userId}:`),
  })
}
```

The callback route doesn't know which user it belongs to, so carry that in the flow's
metadata and read it back:

```ts
app.get('/auth/login', async (c) => {
  const userId = c.get('userId')
  const { url, state } = await clientFor(userId).createAuthorization({
    metadata: { userId },
  })
  // Remember which user owns this state, so the callback can find them again.
  await sharedStorage.set(`state-owner:${state}`, userId)
  return c.redirect(url)
})

app.get('/auth/callback', async (c) => {
  const state = new URL(c.req.url).searchParams.get('state')!
  const userId = await sharedStorage.get(`state-owner:${state}`)
  if (!userId) return c.text('Unknown sign-in request.', 400)

  const tokens = await clientFor(userId).completeAuthorization({ callbackUrl: c.req.url })
  return c.json({ signedInAs: tokens.email })
})
```

> **Do not use `echoesState: false` providers here.** OpenRouter never returns `state`,
> so its flows resolve against "the most recently started one" — which in a multi-user
> server means one user can complete another's login. That mode is for CLIs and
> single-flow apps only.

---

## Database-backed storage

`AuthStorage` is three methods, plus an optional fourth. Anything with a key/value
shape works.

```ts
import type { AuthStorage } from '@ai-oauth-sdk/core'

export function redisStorage(redis: Redis, prefix = 'aioauth:'): AuthStorage {
  return {
    async get(key) {
      return redis.get(prefix + key)
    },
    async set(key, value) {
      // Pending records expire on their own, but a TTL keeps abandoned flows
      // from lingering in Redis regardless.
      await redis.set(prefix + key, value, key.startsWith('pending') ? { EX: 900 } : {})
    },
    async delete(key) {
      await redis.del(prefix + key)
    },
    async keys() {
      // Optional. Enables `listStoredSessions()` and automatic pruning of
      // abandoned flows; omit it and both simply do nothing.
      const found = await redis.keys(`${prefix}*`)
      return found.map((key) => key.slice(prefix.length))
    },
  }
}
```

A SQL version is the same shape — one table of `(key TEXT PRIMARY KEY, value TEXT)`.

**Encrypt at rest.** Tokens are bearer credentials: anyone holding one is the user.
If your database is not already encrypted, wrap the adapter:

```ts
export function encrypted(inner: AuthStorage, key: CryptoKey): AuthStorage {
  return {
    get: async (k) => {
      const stored = await inner.get(k)
      return stored ? decrypt(stored, key) : null
    },
    set: (k, v) => inner.set(k, encrypt(v, key)),
    delete: (k) => inner.delete(k),
    ...(inner.keys ? { keys: () => inner.keys!() } : {}),
  }
}
```

---

## Electron

The renderer can't bind a loopback port, so run the flow in the main process and hand
the result across IPC. Never expose the token to the renderer if you can avoid it —
make the main process do the API calls.

```ts
// main.ts
import { ipcMain, shell } from 'electron'
import { createNodeAuthClient, loopbackReceiver } from '@ai-oauth-sdk/node'
import { createAuthenticatedFetch, publicClientIds } from '@ai-oauth-sdk/core'

const client = createNodeAuthClient({ provider: 'openai', clientId: publicClientIds.openai })

ipcMain.handle('auth:login', async () => {
  const tokens = await client.login({
    receiver: loopbackReceiver({ openBrowser: false }),
    // Electron's shell opens the user's real browser, which keeps their
    // provider session and password manager available.
    openUrl: (url) => shell.openExternal(url),
  })
  // Return only what the UI needs to render — not the token.
  return { email: tokens.email, expiresAt: tokens.expiresAt }
})

ipcMain.handle('auth:status', () => client.isAuthenticated())

const api = createAuthenticatedFetch(client)
ipcMain.handle('api:models', async () => (await api('/models')).json())
```

---

## Wrapping an SDK that expects an API key

Most provider SDKs take an `apiKey` string at construction time and never ask again,
which breaks the moment the token refreshes. Two ways round it.

**If the SDK accepts a custom fetch** — the clean option:

```ts
import OpenAI from 'openai'
import { createAuthenticatedFetch } from '@ai-oauth-sdk/core'

const openai = new OpenAI({
  apiKey: 'unused',                 // the fetch supplies the real Authorization
  fetch: createAuthenticatedFetch(client),
})
```

**If it doesn't** — build it per call, so each one gets a fresh token:

```ts
async function openai() {
  return new OpenAI({ apiKey: await client.getAccessToken() })
}

const response = await (await openai()).chat.completions.create({ /* … */ })
```

`getAccessToken()` is cheap when the token is still valid — it only hits the network
inside the expiry window, and concurrent callers share one refresh.

---

## Testing your integration

Don't mock the library — point it at a fake authorization server and drive the real
flow. `defineProvider` makes this three lines:

```ts
import { createAuthClient, defineProvider, memoryStorage } from '@ai-oauth-sdk/core'

const testProvider = (baseUrl: string) =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${baseUrl}/authorize`,
    tokenUrl: `${baseUrl}/token`,
    scopes: ['openid'],
    redirect: { mode: 'loopback', loopbackPort: 0 },
  })

const client = createAuthClient({
  provider: testProvider(fakeServer.url),
  redirectUri: 'http://localhost/callback',
  storage: memoryStorage(),
})
```

This repo's own
[`fakeAuthServer`](../packages/core/test/helpers/fakeAuthServer.ts) is a good starting
point: it validates PKCE by recomputing the S256 challenge, rotates refresh tokens,
serves a protected endpoint that rejects stale tokens, and can run the device grant.

To exercise your error handling, make it fail on demand:

```ts
const failing = await startFakeAuthServer({ failWith: 'invalid_grant' })
```
