import { getLLMText, source } from '@/lib/source'

import type { Route } from './+types/mdx'

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = (params['*'] ?? '').split('/').filter((segment) => segment.length > 0)

  // Drop the trailing "content.md" the URL carries.
  slugs.pop()

  const page = source.getPage(slugs)

  if (!page) {
    return new Response('not found', { status: 404 })
  }

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown' },
  })
}
