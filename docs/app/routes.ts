import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  route('api/search', 'routes/search.ts'),

  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/*', 'llms/mdx.ts'),

  // The splat matches everything below `/`; React Router matches an empty
  // remainder against the root layout, so `/` needs its own route.
  index('routes/index.tsx'),
  route('*', 'routes/docs.tsx'),
] satisfies RouteConfig
