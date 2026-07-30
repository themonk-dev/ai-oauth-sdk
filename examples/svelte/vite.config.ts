import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { mockProvider } from '@ai-oauth-sdk-example/shared/vite-plugin'

export default defineConfig({
  // mockProvider serves /mock/authorize and /mock/token, so the demo runs
  // offline against a real PKCE flow. See examples/shared/mock-provider.ts.
  plugins: [svelte(), mockProvider()],
  build: {
    rollupOptions: {
      // callback.html must be a Vite entry, not a public/ file, or its bare
      // import of @ai-oauth-sdk/browser would never resolve.
      input: { main: 'index.html', callback: 'callback.html' },
    },
  },
})
