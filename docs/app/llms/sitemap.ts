import { siteUrl } from '@/lib/shared'
import { source } from '@/lib/source'

export function loader() {
  const urls = [{ url: '/', priority: '1.0' }, ...source.getPages().map((page) => ({ url: page.url, priority: '0.8' }))]

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      ({ url, priority }) =>
        `  <url><loc>${siteUrl}${url}</loc><priority>${priority}</priority></url>`,
    ),
    '</urlset>',
  ].join('\n')

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } })
}
