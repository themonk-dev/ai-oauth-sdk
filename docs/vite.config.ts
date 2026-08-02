import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite'

/**
 * The version the docs describe, read from the package rather than written down
 * here, so the picker cannot drift from what changesets published.
 */
const corePackage = fileURLToPath(new URL('../packages/core/package.json', import.meta.url))
const { version } = JSON.parse(readFileSync(corePackage, 'utf8')) as { version: string }

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(version),
  },
  plugins: [fumadocsMdx(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
})
