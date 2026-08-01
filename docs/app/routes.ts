import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  route('api/search', 'routes/search.ts'),

  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/*', 'llms/mdx.ts'),

  // Docs are served from the root. The splat matches everything below `/`, and
  // the index route covers `/` itself, which the splat does not see.
  index('routes/index.tsx'),
  route('*', 'routes/docs.tsx'),
] satisfies RouteConfig
