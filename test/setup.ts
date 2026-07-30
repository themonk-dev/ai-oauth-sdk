import { webcrypto } from 'node:crypto'

/**
 * Ensures `globalThis.crypto` exists before any test runs.
 *
 * Node exposes it in the main context, but not inside a VM context — which is
 * how vitest executes test files on Node 18. Without this, core's runtime
 * detection sees no CSPRNG and throws, which would be a false failure: a real
 * Node 18 process running this library does have the global.
 *
 * This only fills a gap; where the global already exists it is left alone, so
 * the tests that deliberately remove it still work.
 */
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  })
}
