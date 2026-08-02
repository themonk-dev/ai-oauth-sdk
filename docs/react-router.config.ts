import { glob } from 'node:fs/promises'
import { createGetUrl, getSlugs } from 'fumadocs-core/source'

import type { Config } from '@react-router/dev/config'

const getUrl = createGetUrl('/docs')

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


    return paths
  },
} satisfies Config
