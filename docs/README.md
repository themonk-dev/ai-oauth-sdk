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

`pnpm docs:install` is a separate step because this directory has its own lockfile, and a
`pnpm install` at the repository root does not reach it. Run it before `docs:dev`. `docs:build`
installs on its own, so that deploying from the repository root is one command.

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
  components/     cards, provider marks and wordmarks, search dialog, MDX registry
  lib/            source loader, shared config, the docs page shell
  llms/           llms.txt, llms-full.txt and the per-page markdown mirrors
  routes/         home (/), docs index, splat (everything else), search
content/          the MDX, with meta.json driving the sidebar
```

`/` is the landing page and `/docs` is the documentation, both from this one app. Two routes render
a documentation page: one for `/docs` itself, and a splat for everything below it, because React
Router matches an empty remainder against the layout rather than against a splat.

## Provider marks

Each provider has two marks, and they are deliberately different things.

The sidebar and the page tree use Remix Icon, named in each page's `icon` frontmatter and resolved
through `app/lib/icons.ts`. Those render at 16px, where a detailed brand mark turns to mush.

The page title and the providers grid use the provider's own mark, in
`app/components/provider-logos.tsx`, keyed by provider id. Pages under `content/providers/` are named
after the id, so `docs-page.tsx` looks the mark up from the filename and needs no extra frontmatter.
Four providers publish a wordmark that already includes their name
(`app/components/provider-wordmarks.tsx`); the rest get the mark with the name set beside it.

Marks that are a flat colour are redrawn with `currentColor`, or they would vanish against a dark
background. Marks with gradients keep them, and their gradient ids are prefixed, since two of these
can appear on one page.

## The landing page

`/` does not use the docs theme. It has its own palette and typeface, taken from the design, as
`--lp-*` variables in `app/app.css` and exposed to Tailwind through `@theme inline` so `bg-lp-bg`
and `text-lp-muted` work like any other colour utility. Light is the design's values verbatim; dark
mirrors each one across the same neutral ramp it was picked from. Nothing under `/docs` reads them.

`ProviderGrid` renders in both places and takes a `tone` for that reason. The nav is Fumadocs'
`HomeLayout` rather than the design's own, so search, the theme switch and the mobile menu keep
working and match the docs.

The docs do borrow one value back: Fumadocs' `solar` theme paints `--color-fd-primary` blue, which
tinted every link, active sidebar row and icon chip. It is overridden with `--lp-fg`, so the whole
site is the same monochrome.

## Social cards and SEO

`app/lib/seo.ts` builds the `og:` and `twitter:` tags, the canonical link, and the JSON-LD on the
home page. Every page gets its own title, description and URL; the card image is shared.

**The card cannot follow the reader's theme.** A crawler fetches `og:image` once and the platform
caches the result, so there is no request to vary on. `public/og.png` is the light one and ships;
`public/og-dark.png` exists for the places that *can* choose, such as a `<picture>` in a README.

Both are rendered from `og/card.html` and `og/card-dark.html`. To change one, edit the template and
screenshot it at 1200x630 with any headless browser, writing over the PNG in `public/`. The
templates are plain HTML with the marks inlined, so nothing needs installing to open them.

`sitemap.xml` is generated in `app/llms/sitemap.ts` from the same loaders that build the sidebar, so
a new page is listed by existing there. Archived versions are included at a lower priority.

The base path lives in one place, `docsRoute` in `app/lib/shared.ts`. Changing it moves the loader,
the prerender list and the nav together, but absolute links written in MDX are not derived from it
and would need updating too.

## Writing

Every page is MDX with frontmatter:

```mdx
---
title: Loopback
description: One sentence. It is the page subtitle and the meta description.
icon: RiServerLine
---
```

`icon` is any name exported from [Remix Icon](https://remixicon.com), plus the handful of marks it
does not carry in `app/components/brand-icons.tsx`. Both go through the map in `app/lib/icons.ts`,
which is a named list rather than a namespace import so the bundle carries the fifty icons this site
uses instead of all three thousand. An icon not in that map silently renders nothing.

Sidebar order and grouping come from the `meta.json` next to the content. A `---Label---` entry in
the root `meta.json` renders as a section separator.

`Tabs`, `Steps`, `Accordions`, `TypeTable`, `Callout` and `Cards` are registered globally in
`app/components/mdx.tsx`, so pages do not import them.

## Deploying

`pnpm build` produces a static site in `build/client`. Every page is prerendered, and search runs in
the browser against a static index, so there is no server component.

Point any static host at `build/client`. One thing to configure, and one not to:

- Serve files as they are. Do not add a catch-all rewrite to `__spa-fallback.html`, or every URL
  gets the fallback shell instead of its prerendered HTML, and hydration then fails with
  `No result found for routeId`.
- Do not map 404s to `__spa-fallback.html` either. It looks like a way to get the styled not-found
  page, but the shell hydrates, asks for route data that is not there, and renders "Something went
  wrong" instead. A plain 404 from the host is the better answer until there is a real 404 page.

On Vercel, set the root directory to `docs` and leave the framework preset to auto-detect. The
nested lockfile is picked up automatically.

### Cloudflare

`wrangler.jsonc` at the **repository root** is the deploy config: a Worker with nothing but static
assets, since `ssr: false` means there is no server to run. It sits up there rather than beside the
site because that is where the deploy runs, and the asset settings that matter are commented in it.

Workers Builds keeps two settings in its dashboard, and both are its defaults:

| Setting | Value |
| --- | --- |
| Root directory | *(repository root)* |
| Build command | `pnpm docs:build` |
| Deploy command | `npx wrangler deploy` |

Everything else is in the repository. The two commands each had to earn that, because run from the
repository root neither of them works as written by default:

- A root install skips this directory by design. `pnpm-workspace.yaml` here declares no packages,
  which is exactly what keeps Vite and the MDX toolchain out of the root lockfile that `pnpm audit`
  reads. So `docs:build` installs first, or the build reaches `react-router build` with no
  `node_modules` beside it and stops at `react-router: not found`, which reads like a missing
  dependency and is not one.
- `wrangler deploy` with no config beside it finds the SDK's pnpm workspace and refuses to guess
  which project it is meant to ship, saying so as *"application detection logic has been run in the
  root of a workspace"*. The root `wrangler.jsonc` answers that, which is the whole reason it lives
  there instead of here.

The deploy uploads whatever is in `docs/build/client` and does not build it, which is why the build
command runs first. On its own with nothing built it stops on the missing assets directory, and
names it. `pnpm docs:deploy` is the same command under a name that matches `docs:build`.

Nothing in the build reads a secret, so the project needs no environment variables. If that ever
changes, turn off builds for non-production branches first, because a fork's pull request would
otherwise run its own code with them.

## Versions

The sidebar footer carries a version picker. It renders as a plain label while there is one version
and becomes a dropdown as soon as a second is archived, so it is never a menu with nothing in it.

`defineDocs` is a macro, so a collection has to exist at build time. An archived version cannot be
discovered from the filesystem and needs four changes:

1. Copy `content/` to `versions/<slug>/`, then rewrite its internal links:
   `sed -i 's|](/docs/|](/docs/v/<slug>/|g'`. Without that, every link in the archive drops the
   reader back into the current docs.
2. Add a collection and a loader in `app/lib/source.ts`, with `baseUrl: '/docs/v/<slug>'`.
3. Register it in `collections` in `app/lib/docs-page.tsx`, add an entry to `docsVersions` in
   `app/lib/versions.ts`, and add two routes in `app/routes.ts`, an index and a splat. Put them
   above `docs/*`, which would otherwise swallow them.
4. Add the directory to `archived` in `react-router.config.ts`, or nothing prerenders.

Archives live in `versions/`, not under `content/`, because the macro globs `content/**` and would
pull an archived copy into the current sidebar.

**Slugs carry no dot.** `0.3` in a path makes some static hosts read the segment as a filename and
answer with a directory listing rather than the page, so the archive is served from `/docs/v/0-3`
while the picker still says `0.3`.

The picker resolves each version's link at build time and falls back to that version's index when
the current page does not exist there. That matters after a rename: `/docs/providers/claude` has no
counterpart in 0.3, where the page was `anthropic`.

The cost is a full copy of the content tree per archived version, so this is worth doing at a
breaking release rather than at every patch.
