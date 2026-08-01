import { loader } from 'fumadocs-core/source'
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons'
import { defineDocs } from 'fumadocs-mdx/macro'

import { docsContentRoute, docsRoute } from './shared'

export const docs = defineDocs({
  dir: 'content',
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
})

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  // Turns the `icon:` string in a page's frontmatter, and in meta.json, into
  // the matching Lucide component. Without it the sidebar prints the name.
  plugins: [lucideIconsPlugin()],
})

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md']

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  }
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  const processed = await page.data.getText('processed')

  return `# ${page.data.title} (${page.url})

${processed}`
}
