import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: ['@ai-oauth-sdk/core', '@ai-oauth-sdk/node'],
  banner: { js: '#!/usr/bin/env node' },
})
