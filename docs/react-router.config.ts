import { glob } from 'node:fs/promises'
import { createGetUrl, getSlugs } from 'fumadocs-core/source'

import type { Config } from '@react-router/dev/config'

const getUrl = createGetUrl('/docs')

/** Archived versions, matching the collections in `app/lib/source.ts`. */
const archived = [{ dir: 'versions/0-3', getUrl: createGetUrl('/docs/v/0-3') }]

/**
 * No SSR: every page is rendered at build time and the result is a directory of
 * static files. A docs site has nothing per-request to compute, and a static
 * build is one less thing to keep running.
 *
 * Because loaders only run during the build, every route that has one has to be
 * listed here. `getStaticPaths()` covers the routes React Router can enumerate
 * on its own; the content pages live behind a splat, so they are globbed.
 */
export default {
  ssr: false,
  async prerender({ getStaticPaths }) {
    const paths = [...getStaticPaths()]

    for await (const entry of glob('**/*.mdx', { cwd: 'content' })) {
      const slugs = getSlugs(entry)

      paths.push(getUrl(slugs), `/llms.mdx/${[...slugs, 'content.md'].join('/')}`)
    }

    // Archived pages get an HTML file but no markdown route: `llms.mdx` serves
    // the current docs, and an agent reading this site wants those.
    for (const version of archived) {
      for await (const entry of glob('**/*.mdx', { cwd: version.dir })) {
        paths.push(version.getUrl(getSlugs(entry)))
      }
    }

    return paths
  },
} satisfies Config
