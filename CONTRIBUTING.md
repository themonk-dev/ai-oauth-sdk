# Contributing

Thanks for helping out. Issues, provider reports and pull requests are all welcome.

## Getting started

Node 24 is pinned in `.nvmrc`, so `nvm use` picks it up. CI also runs 22 and 26.

```bash
pnpm install
pnpm verify      # lint, typecheck, build, test, exports check
```

Run `pnpm verify` before opening a pull request. `pnpm test` on its own is not enough: vitest
transpiles with esbuild and never typechecks, so a suite can be green while the package does not
compile.

```bash
pnpm test:watch                # while iterating
pnpm vitest run packages/core  # one package
pnpm vitest run -t "refresh"   # one test by name
```

## Layout

```
packages/
  core/         zero-dependency engine: PKCE, registry, exchange, refresh, providers, store
  node/         loopback server, file storage, browser launcher
  browser/      popup and redirect receivers, web storage
  cli/          the ai-oauth-sdk binary
  react/ vue/ svelte/ solid/    UI bindings, all thin wrappers over the core store
  react-native/ deep link and auth session, SecureStore
  ai-oauth-sdk/ umbrella package and the CDN bundle
docs/           the documentation site
examples/       four examples, each against a real provider
```

**Core stays dependency-free and platform-free.** No `node:` imports, no DOM globals at module
scope, no npm dependencies. Anything platform-specific belongs in an adapter package. That
constraint is what lets the same code run in a CLI, a browser, Hermes and a `<script>` tag, and it
is the one rule worth being strict about.

## Adding a provider

Most providers need only a descriptor in `packages/core/src/providers/`. Start from an existing one
that shares the same shape and change what differs.

```ts
export const acme = defineProvider({
  id: 'acme',
  label: 'Acme AI',
  authorizationUrl: 'https://auth.acme.dev/authorize',
  tokenUrl: 'https://auth.acme.dev/token',
  scopes: ['openid', 'inference'],
  redirect: { mode: 'loopback', loopbackPort: 0 },
})
```

`defineProvider` fills in the defaults almost everyone shares: PKCE on with S256, a form-encoded
token request carrying the client id, `/callback` as the loopback path. State only what makes yours
different.

If the provider leaves the spec, reach for the hooks rather than adding a branch to the flow code.
`buildAuthParams` rewrites the authorization query, `parseTokenResponse` normalises a non-standard
token body, and `parseCallback` handles whatever the user pastes back. OpenRouter is the proof that
those three are enough: it sends no `client_id`, names its redirect `callback_url`, and returns
`{ key }` instead of `{ access_token }`, and none of that is special-cased anywhere else.

Say in the pull request where the values came from. An endpoint or client id observed in a vendor's
shipped CLI should name the tool and the version you read it from, so the next person can check it.

Do not add a client id that is not already published by the vendor in software they distribute.

## Tests

The flow tests drive a real OAuth server rather than a mock. It validates PKCE by recomputing the
S256 challenge from the verifier, rotates refresh tokens, and serves a protected endpoint that
rejects stale ones. That means a broken verifier fails the suite instead of only failing in
production, and it is worth adding to rather than working around.

`startFakeAuthServer({ failWith: 'invalid_grant' })` makes it fail on demand, which is how the error
paths get covered.

## Commits and releases

Changesets. Add one with `pnpm changeset` describing what changed from a consumer's point of view,
not what you edited. All ten packages are held at the same version, so a patch to the core bumps
everything.

Commit messages follow Conventional Commits.

## Working on the docs

The site under `docs/` is a separate project with its own lockfile, deliberately outside the pnpm
workspace so its toolchain stays out of the root lockfile and out of the audit gate that covers the
published packages.

```bash
cd docs
pnpm install
pnpm dev      # http://localhost:5173
```

Content is MDX under `docs/content`, and the sidebar comes from the `meta.json` files beside it.
More detail is in [docs/README.md](docs/README.md).

## Reporting security issues

Privately, not in a public issue. See [SECURITY.md](SECURITY.md).
