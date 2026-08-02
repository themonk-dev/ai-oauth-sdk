import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  route('api/search', 'routes/search.ts'),

  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/*', 'llms/mdx.ts'),
  route('sitemap.xml', 'llms/sitemap.ts'),

  index('routes/home.tsx'),
  route('demo', 'routes/demo.tsx'),

  // React Router matches an empty remainder against the layout rather than a
  // splat, so `/docs` needs its own route alongside everything below it.
  route('docs', 'routes/index.tsx'),
  route('docs/*', 'routes/docs.tsx'),
] satisfies RouteConfig
