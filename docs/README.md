# Documentation site

The docs for `ai-oauth-sdk`, built with [Fumadocs](https://fumadocs.dev) on React Router.

Node 24 or later, pinned in `.nvmrc`.

From this directory:

```bash
pnpm install
pnpm dev        # dev server with hot reload, http://localhost:5173
pnpm build      # static output in build/client
pnpm start      # serve that output, http://localhost:3000
pnpm typecheck
```

Or from the repository root, without changing directory:

```bash
pnpm docs:install
pnpm docs:dev
pnpm docs:build
pnpm docs:start
pnpm docs:typecheck
```

Both take the usual flags, so `pnpm docs:dev --port 4000` and
`pnpm docs:start --listen 4000` work.

`pnpm docs:install` is a separate step because this directory has its own lockfile. A `pnpm install`
at the repository root does not reach it.

## Why this is not in the workspace

`docs/` has its own `pnpm-workspace.yaml` and its own `pnpm-lock.yaml`, which keeps it out of the
SDK's pnpm workspace on purpose.

The published packages have zero runtime dependencies, and the package CI runs
`pnpm audit --audit-level high` as a hard gate. `pnpm audit` reads `pnpm-lock.yaml` rather than
`node_modules`, so a docs app inside the workspace would put Vite, React Router and the whole MDX
toolchain inside a gate that is meant to say something about the SDK. It would also drag a full
install through the Node 22/24/26 matrix on every pull request.

The cost is that the site depends on `ai-oauth-sdk` from npm rather than through a workspace link.
That is arguably a feature: code samples are checked against the published API rather than against
unreleased source. To preview docs for unreleased changes, add a temporary override:

```json
"ai-oauth-sdk": "file:../packages/ai-oauth-sdk"
```

## Layout

```
app/
  components/     feature and runtime cards, search dialog, logo, MDX registry
  lib/            source loader, shared config, the docs page shell
  llms/           llms.txt, llms-full.txt and the per-page markdown mirrors
  routes/         index (/), splat (everything else), search
content/          the MDX, with meta.json driving the sidebar
```

Docs are served from `/docs`, so `content/index.mdx` is at `/docs` and everything else hangs off it.
Two routes render a page: one for `/docs` itself, and a splat for everything below it, because React
Router matches an empty remainder against the layout rather than against a splat. `/` redirects to
`/docs`, so a deployment at a domain root does not answer with a 404.

The base path lives in one place, `docsRoute` in `app/lib/shared.ts`. Changing it moves the loader,
the prerender list and the nav together, but absolute links written in MDX are not derived from it
and would need updating too.

## Writing

Every page is MDX with frontmatter:

```mdx
---
title: Loopback
description: One sentence. It is the page subtitle and the meta description.
icon: Server
---
```

`icon` is any name from [Lucide](https://lucide.dev). Note that Lucide 1.x dropped the brand icons,
so `Github` and `Chrome` no longer resolve.

Sidebar order and grouping come from the `meta.json` next to the content. A `---Label---` entry in
the root `meta.json` renders as a section separator.

`Tabs`, `Steps`, `Accordions`, `TypeTable`, `Callout` and `Cards` are registered globally in
`app/components/mdx.tsx`, so pages do not import them.

## Deploying

`pnpm build` produces a static site in `build/client`. Every page is prerendered, and search runs in
the browser against a static index, so there is no server component.

Point any static host at `build/client`. Two things to configure:

- Serve files as they are. Do not add a catch-all rewrite to `__spa-fallback.html`, or every URL
  gets the fallback shell instead of its prerendered HTML, and hydration then fails with
  `No result found for routeId`.
- Map 404s to `__spa-fallback.html` if you want the styled not-found page instead of the host's.

On Vercel, set the root directory to `docs` and leave the framework preset to auto-detect. The
nested lockfile is picked up automatically.

## Versions

The sidebar footer carries a version picker. It renders as a plain label while there is one version
and becomes a dropdown as soon as a second is archived, so it is never a menu with nothing in it.

`defineDocs` is a macro, so a collection has to exist at build time. An archived version cannot be
discovered from the filesystem and needs three changes:

1. Copy `content/` to `content/v/<version>/`.
2. Add a collection for it in `app/lib/source.ts`, and a loader with
   `baseUrl: '/docs/v/<version>'`.
3. Add an entry to `docsVersions` in `app/lib/versions.ts`, and a route for it in `app/routes.ts`.

That is the same shape other Fumadocs sites use for this, and the cost is a full copy of the content
tree per archived version. Worth doing at a major release rather than at every patch.
