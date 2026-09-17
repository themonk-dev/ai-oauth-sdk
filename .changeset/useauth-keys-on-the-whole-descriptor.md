---
'@ai-oauth-sdk/react': patch
'ai-oauth-sdk': patch
---

`useAuth()` keys its client on the whole provider descriptor, not just its `id`

`azureAi({ clientId, tenant })` hard-codes `id: 'azure-ai'` while scoping
`authorizationUrl` and `tokenUrl` to the tenant, so two descriptors that differ
only by tenant hashed equal. Switching tenant returned the previous client,
still pointed at the previous tenant's endpoints, and `getAccessToken()` went on
serving that tenant's cached access token. The docstring and the React guide
both already said the store is rebuilt when something that changes the client's
behaviour changes, and an endpoint is such a thing.

Two limits are worth knowing. Function-valued fields (`parseCallback`,
`enrichTokens`, `apiHeaders`, `transformRequestBody`) do not survive
`JSON.stringify`, so descriptors differing only in a hook still hash equal; and
the key depends on property order, which `defineProvider` takes from the
caller's own literal rather than imposing, so it is stable for any one call site
but not across two that spell the same descriptor differently. Re-keying
separates the in-memory clients only — two of them for one `id` still read the
same `tokens:<id>` record out of a persistent storage, which is what
`accountKey` is for.
