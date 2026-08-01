import { loader } from 'fumadocs-core/source'
import { defineDocs } from 'fumadocs-mdx/macro'
import { createElement } from 'react'

import { icons } from './icons'
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
  icon(name) {
    if (!name) {
      return undefined
    }

    const Icon = icons[name]

    if (!Icon) {
      return undefined
    }

    return createElement(Icon)
  },
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
