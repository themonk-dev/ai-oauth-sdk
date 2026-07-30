import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolvePackage = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Run tests against source rather than dist, so a stale build cannot mask a
    // change. The published output is verified separately by `pnpm build`.
    alias: {
      '@ai-oauth-sdk/core': resolvePackage('core'),
      '@ai-oauth-sdk/node': resolvePackage('node'),
      '@ai-oauth-sdk/browser': resolvePackage('browser'),
      '@ai-oauth-sdk/cli': resolvePackage('cli'),
      '@ai-oauth-sdk/react': resolvePackage('react'),
      '@ai-oauth-sdk/vue': resolvePackage('vue'),
      '@ai-oauth-sdk/svelte': resolvePackage('svelte'),
      '@ai-oauth-sdk/solid': resolvePackage('solid'),
      '@ai-oauth-sdk/react-native': resolvePackage('react-native'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    // Node by default; suites that need a DOM opt in with
    // `// @vitest-environment jsdom` at the top of the file.
    environment: 'node',
    environmentOptions: {
      // jsdom defaults to about:blank, where history.replaceState and any
      // origin-scoped storage throw a SecurityError.
      jsdom: { url: 'http://localhost/' },
    },
    testTimeout: 20_000,
  },
})
