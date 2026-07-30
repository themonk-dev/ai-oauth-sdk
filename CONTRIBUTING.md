# Contributing

Thanks for helping out.

## Getting started

Node 24 is pinned in `.nvmrc`; `nvm use` picks it up. CI also runs 22 and 26.

```bash
pnpm install
pnpm verify      # typecheck && build && test && exports check — the whole gate
```

Run `pnpm verify` before opening a PR. `pnpm test` alone is not enough: vitest
transpiles with esbuild and never typechecks, so a suite can be green while the
package does not compile.

```bash
pnpm test:watch                        # while iterating
pnpm vitest run packages/core          # one package
pnpm vitest run -t "refresh"           # one test by name
```

## Layout

```
packages/
  core/          zero-dep engine — PKCE, registry, exchange, refresh, providers, store
  node/          loopback server, file storage, browser launcher
  browser/       popup + redirect receivers, web storage
  cli/           the ai-oauth-sdk binary
  react/ vue/ svelte/ solid/   UI bindings (all thin wrappers over core's store)
  react-native/  deep link + auth session, SecureStore
  ai-oauth-sdk/      umbrella package and the CDN bundle
```

**Core must stay dependency-free and platform-free.** No `node:` imports, no DOM
globals at module scope, no npm dependencies. Anything platform-specific belongs in an
adapter package. This is what lets the same code run in a CLI, a browser, Hermes and a
`<script>` tag.

## Adding a provider

Most providers need only a descriptor in `packages/core/src/providers/`:

```ts
export const acme = defineProvider({
  id: 'acme',
  label: 'Acme AI',
  clientId: '…',            // omit if the vendor publishes none
  authorizationUrl: '…',
  tokenUrl: '…',
  scopes: ['openid'],
  redirect: { mode: 'loopback', loopbackPort: 0 },
})
```

Register it in `providers/index.ts`, then add tests.

If it deviates from OAuth 2.0, use the existing hooks rather than special-casing in
the client — `buildAuthParams` rewrites the authorization query, `parseTokenResponse`
normalizes a non-standard token body, `parseCallback` handles an odd callback format,
and `enrichTokens` pulls out the account id. `openrouter.ts` uses three of the four and
is the best reference.

**Do not commit client secrets.** Ship the descriptor without credentials and require
the consumer to supply them, as `google` and `xai` do. GitHub's push protection will
reject the commit anyway, and it is the right call regardless: a client credential
belongs to whoever registered it.

## Tests

Tests run against source, not `dist`, so a stale build cannot mask a change.

Prefer exercising the real thing over mocking it. `packages/core/test/helpers/fakeAuthServer.ts`
is a small OAuth server that validates PKCE by recomputing the S256 challenge, rotates
refresh tokens, serves a protected API that rejects stale tokens, and can run the
device grant — so a broken verifier fails the suite instead of only failing in
production. Point a provider descriptor at it and drive the real flow.

Suites needing a DOM opt in per file:

```ts
// @vitest-environment jsdom
```

## Commits and releases

Conventional prose commit subjects; explain *why* in the body, not just what.

Releases use [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset            # describe the change
pnpm changeset version    # bump versions and write changelogs
```

All packages are version-locked together, so one changeset covers a change that spans
several of them.

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
