import { docsPageMeta, DocsPageView, loadDocsPage } from '@/lib/docs-page'

import type { Route } from './+types/docs'

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = (params['*'] ?? '').split('/').filter((segment) => segment.length > 0)

  return loadDocsPage(slugs)
}

export function meta({ loaderData }: Route.MetaArgs) {
  return docsPageMeta(loaderData)
}

export default function Page({ loaderData }: Route.ComponentProps) {
  return <DocsPageView loaderData={loaderData} />
}
