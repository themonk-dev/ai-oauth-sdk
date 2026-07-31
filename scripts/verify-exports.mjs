#!/usr/bin/env node
/**
 * Verifies that every published subpath actually resolves — in ESM, in CJS, and
 * for TypeScript.
 *
 * Broken `exports` maps are invisible to unit tests (which import source) and
 * to `tsc` (which resolves through workspace `paths`). They only surface once
 * someone installs the package, which is far too late. This runs against built
 * `dist` output through Node's real resolver, from a directory laid out the way
 * node_modules would be.
 *
 * Run after `pnpm build`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const packagesDir = join(repoRoot, 'packages')

const SCOPED = ['core', 'node', 'browser', 'react', 'vue', 'svelte', 'solid', 'react-native', 'cli']

/** [specifier, expected named export] */
const ESM_CHECKS = [
  ['ai-oauth-sdk/core', 'createAuthClient'],
  ['ai-oauth-sdk/node', 'login'],
  ['ai-oauth-sdk/browser', 'popupReceiver'],
  ['ai-oauth-sdk/react', 'useAuth'],
  ['ai-oauth-sdk/vue', 'useAuth'],
  ['ai-oauth-sdk/svelte', 'createAuth'],
  ['ai-oauth-sdk/solid', 'createAuth'],
  ['ai-oauth-sdk/react-native', 'deepLinkReceiver'],
  ['@ai-oauth-sdk/core', 'createAuthStore'],
  ['@ai-oauth-sdk/node', 'loopbackReceiver'],
  ['@ai-oauth-sdk/browser', 'handleRedirectCallback'],
  ['@ai-oauth-sdk/cli', 'run'],
]

const CJS_CHECKS = [
  ['ai-oauth-sdk/core', 'createAuthClient'],
  ['ai-oauth-sdk/node', 'login'],
  ['@ai-oauth-sdk/core', 'createAuthStore'],
  ['@ai-oauth-sdk/browser', 'popupReceiver'],
]

const TYPE_CHECK_SOURCE = `
import { createAuthClient, createAuthStore, type ProviderConfig, type TokenSet } from 'ai-oauth-sdk/core'
import { login, loopbackReceiver } from 'ai-oauth-sdk/node'
import { popupReceiver } from 'ai-oauth-sdk/browser'
import { createAuth } from 'ai-oauth-sdk/svelte'
import type { AuthStore } from '@ai-oauth-sdk/core'

const client = createAuthClient({ provider: 'openai' })
const provider: ProviderConfig = client.provider
const store: AuthStore = createAuthStore({ client })

export async function main(): Promise<TokenSet> {
  void popupReceiver
  void createAuth
  void provider.label
  void store.getState().isAuthenticated
  return login('anthropic', { receiver: loopbackReceiver({ port: 0 }) })
}
`

const dir = mkdtempSync(join(tmpdir(), 'aioauth-exports-'))
let failures = 0

const report = (ok, message) => {
  if (!ok) {
    failures++
  }

  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${message}`)
}

try {
  // Lay the workspace out the way node_modules would be, so Node's resolver
  // reads the real package.json "exports" rather than workspace aliases.
  mkdirSync(join(dir, 'node_modules', '@ai-oauth-sdk'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'exports-check', type: 'module', version: '1.0.0' }),
  )
  symlinkSync(join(packagesDir, 'ai-oauth-sdk'), join(dir, 'node_modules', 'ai-oauth-sdk'))

  for (const name of SCOPED) {
    symlinkSync(join(packagesDir, name), join(dir, 'node_modules', '@ai-oauth-sdk', name))
  }

  console.log('ESM subpaths')
  const esmScript = ESM_CHECKS.map(
    ([spec, name]) =>
      `try { const m = await import(${JSON.stringify(spec)});
         console.log((typeof m[${JSON.stringify(name)}] === 'function' ? 'OK' : 'MISSING_EXPORT') + ' ${spec}') }
       catch (e) { console.log('RESOLVE_ERROR ${spec}: ' + e.message) }`,
  ).join('\n')

  for (const line of execFileSync(process.execPath, ['--input-type=module', '-e', esmScript], {
    cwd: dir,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')) {
    report(line.startsWith('OK '), line)
  }

  console.log('\nCJS require()')
  const cjsScript = CJS_CHECKS.map(
    ([spec, name]) =>
      `try { const m = require(${JSON.stringify(spec)});
         console.log((typeof m[${JSON.stringify(name)}] === 'function' ? 'OK' : 'MISSING_EXPORT') + ' ${spec}') }
       catch (e) { console.log('RESOLVE_ERROR ${spec}: ' + e.message) }`,
  ).join('\n')

  for (const line of execFileSync(process.execPath, ['--input-type=commonjs', '-e', cjsScript], {
    cwd: dir,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')) {
    report(line.startsWith('OK '), line)
  }

  console.log('\nBare specifier picks the right build per condition')
  const bare = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import('ai-oauth-sdk'); console.log(typeof m.login === 'function' ? 'OK node' : 'WRONG_BUILD')`,
    ],
    { cwd: dir, encoding: 'utf8' },
  ).trim()
  report(bare.startsWith('OK'), `import 'ai-oauth-sdk' under node -> ${bare}`)

  console.log('\nTypeScript resolution (moduleResolution: NodeNext)')
  writeFileSync(join(dir, 'check.ts'), TYPE_CHECK_SOURCE)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['check.ts'],
    }),
  )

  try {
    execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    report(true, 'types resolve for all subpaths')
  } catch (error) {
    report(false, `types failed to resolve:\n${error.stdout ?? error.message}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(
  failures === 0 ? '\nAll published entry points resolve.' : `\n${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
