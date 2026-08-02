import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  route('api/search', 'routes/search.ts'),

  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/*', 'llms/mdx.ts'),

  index('routes/home.tsx'),

  // Archived versions come first. `docs/*` would otherwise swallow `docs/v/0-3`
  // and try to resolve it as a page in the current collection.
  route('docs/v/0-3', 'routes/docs-v03-index.tsx'),
  route('docs/v/0-3/*', 'routes/docs-v03.tsx'),

  // React Router matches an empty remainder against the layout rather than a
  // splat, so `/docs` needs its own route alongside everything below it.
  route('docs', 'routes/index.tsx'),
  route('docs/*', 'routes/docs.tsx'),
] satisfies RouteConfig
