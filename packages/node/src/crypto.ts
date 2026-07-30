import { webcrypto } from 'node:crypto'

import type { CryptoAdapter } from '@ai-oauth-sdk/core'

/**
 * A {@link CryptoAdapter} backed by `node:crypto`.
 *
 * Core deliberately reads `globalThis.crypto`, because that is the only thing
 * every runtime shares. On Node that global is usually present — but not
 * always: it was flagged in early 18.x releases, and it is absent inside a VM
 * context (which is how several test runners and sandboxes execute code). In
 * those environments core would throw `unsupported_runtime` even though the
 * platform has perfectly good WebCrypto sitting in `node:crypto`.
 *
 * Node consumers get this by default via `createNodeAuthClient`, so a login
 * never fails for want of a global that Node has under a different name.
 */
export function nodeCrypto(): CryptoAdapter {
  return {
    randomBytes(length) {
      return webcrypto.getRandomValues(new Uint8Array(length))
    },
    async sha256(data) {
      const digest = await webcrypto.subtle.digest('SHA-256', Uint8Array.from(data))
      return new Uint8Array(digest)
    },
  }
}
