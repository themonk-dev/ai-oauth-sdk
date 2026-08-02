import { docsPageMeta, DocsPageView, loadDocsPage } from '@/lib/docs-page'

import type { Route } from './+types/docs-v03-index'

export async function loader() {
  return loadDocsPage([], '0.3')
}

export function meta({ loaderData }: Route.MetaArgs) {
  return docsPageMeta(loaderData)
}

export default function Page({ loaderData }: Route.ComponentProps) {
  return <DocsPageView loaderData={loaderData} />
}
