import { describe, expect, it } from 'vitest'

import * as reactEntry from '../src/react.js'

/**
 * `ai-oauth-sdk/react` re-exports the browser helpers by name rather than with
 * `export *`, because that package and `@ai-oauth-sdk/react` both re-export the
 * core and a star export drops every name two modules share. A hand-kept list
 * is a list that can be forgotten, and a redirect page needs *both* halves of
 * the handshake: `postCallbackToOpener` returns `false` wherever the
 * authorization page severed the opener, and without `announceCallback` a
 * consumer on this entrypoint has nothing to fall back to.
 */
describe('ai-oauth-sdk/react', () => {
  it('carries both halves of the redirect-page handshake', () => {
    expect(reactEntry.postCallbackToOpener).toBeTypeOf('function')
    expect(reactEntry.announceCallback).toBeTypeOf('function')
  })

  it('carries the receivers and storage a browser client is built from', () => {
    expect(reactEntry.popupReceiver).toBeTypeOf('function')
    expect(reactEntry.redirectReceiver).toBeTypeOf('function')
    expect(reactEntry.handleRedirectCallback).toBeTypeOf('function')
    expect(reactEntry.startRedirectLogin).toBeTypeOf('function')
    expect(reactEntry.loginWithPopup).toBeTypeOf('function')
    expect(reactEntry.localStorageAdapter).toBeTypeOf('function')
    expect(reactEntry.sessionStorageAdapter).toBeTypeOf('function')
  })
})
