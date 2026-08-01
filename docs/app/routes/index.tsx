import { docsPageMeta, DocsPageView, loadDocsPage } from '@/lib/docs-page'

import type { Route } from './+types/index'

export async function loader() {
  return loadDocsPage([])
}

export function meta({ loaderData }: Route.MetaArgs) {
  return docsPageMeta(loaderData)
}

export default function Page({ loaderData }: Route.ComponentProps) {
  return <DocsPageView loaderData={loaderData} />
}
