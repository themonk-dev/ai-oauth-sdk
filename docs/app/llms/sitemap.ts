import { siteUrl } from '@/lib/shared'
import { source, sourceV03 } from '@/lib/source'

/**
 * Archived versions are listed too, but at a lower priority. They are real
 * pages a reader on 0.3 wants to find; they are not what a search engine should
 * rank first.
 */
function urls() {
  const latest = source.getPages().map((page) => ({ url: page.url, priority: '0.8' }))
  const archived = sourceV03.getPages().map((page) => ({ url: page.url, priority: '0.3' }))

  return [{ url: '/', priority: '1.0' }, ...latest, ...archived]
}

export function loader() {
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls().map(
      ({ url, priority }) =>
        `  <url><loc>${siteUrl}${url}</loc><priority>${priority}</priority></url>`,
    ),
    '</urlset>',
  ].join('\n')

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } })
}
