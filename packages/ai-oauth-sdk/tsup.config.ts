import { defineConfig } from 'tsup'

const WORKSPACE_PACKAGES = [
  '@ai-oauth-sdk/core',
  '@ai-oauth-sdk/node',
  '@ai-oauth-sdk/browser',
  '@ai-oauth-sdk/react',
  '@ai-oauth-sdk/react-native',
  '@ai-oauth-sdk/vue',
  '@ai-oauth-sdk/svelte',
  '@ai-oauth-sdk/solid',
]

export default defineConfig([
  // npm consumers: keep the scoped packages external so they dedupe.
  {
    entry: {
      core: 'src/core.ts',
      node: 'src/node.ts',
      browser: 'src/browser.ts',
      react: 'src/react.ts',
      native: 'src/native.ts',
      vue: 'src/vue.ts',
      svelte: 'src/svelte.ts',
      solid: 'src/solid.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    target: 'es2022',
    external: [
      ...WORKSPACE_PACKAGES,
      'react',
      'react-native',
      'vue',
      'svelte',
      'solid-js',
      'expo-web-browser',
      'expo-secure-store',
    ],
  },
  // CDN: one self-contained file on window.AIOAuth.
  {
    entry: { 'ai-oauth-sdk': 'src/global.ts' },
    format: ['iife'],
    globalName: 'AIOAuth',
    dts: false,
    clean: false,
    sourcemap: true,
    minify: true,
    treeshake: true,
    // Deliberately one step behind the npm builds. Every other artifact is
    // consumed by a bundler that can downlevel further if a consumer needs it;
    // this one is served verbatim to whatever browser loads the <script>.
    target: 'es2020',
    platform: 'browser',
    noExternal: WORKSPACE_PACKAGES,
    outExtension: () => ({ js: '.global.js' }),
  },
])
