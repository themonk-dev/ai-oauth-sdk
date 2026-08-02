import { loader } from 'fumadocs-core/source'
import { defineDocs } from 'fumadocs-mdx/macro'
import { createElement } from 'react'

import { icons } from './icons'
import { docsContentRoute, docsRoute } from './shared'

function resolveIcon(name?: string) {
  if (!name) {
    return undefined
  }

  const Icon = icons[name]

  return Icon ? createElement(Icon) : undefined
}

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
  icon: resolveIcon,
})

// Archived versions live outside `content/` so the macro above does not sweep
// them into the current sidebar. Each is a frozen copy: fix a typo in the live
// docs and the archive keeps the typo, which is the point of an archive.
export const docsV03 = defineDocs({
  dir: 'versions/0-3',
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
})

export const sourceV03 = loader({
  source: docsV03.toFumadocsSource(),
  baseUrl: `${docsRoute}/v/0-3`,
  icon: resolveIcon,
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
