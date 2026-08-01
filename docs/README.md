# Documentation site

The docs for `ai-oauth-sdk`, built with [Fumadocs](https://fumadocs.dev) on React Router.

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # static output in build/client
pnpm start    # serve the built output
```

Node 24 or later, pinned in `.nvmrc`.

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

Docs are served from the root rather than under `/docs`, so `content/index.mdx` is the home page.
Two routes render a page: an index route for `/`, and a splat for everything below it. React Router
matches an empty remainder against the root layout rather than against a splat, so one route cannot
serve both.

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
