// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineProvider, type CallbackReceiver, type ProviderConfig } from '@ai-oauth-sdk/core'

import type { PopupReceiverOptions } from '../src/popup.js'

/**
 * The receiver is mocked rather than driven, because what is under test is the
 * handover: `loginWithPopup` used to forward `redirectUri` and nothing else, so
 * every other {@link PopupReceiverOptions} key was unreachable from the entry
 * point the quick-start and both READMEs teach. Asserting on the arguments
 * `popupReceiver` was constructed with says exactly that and nothing more.
 *
 * `start` throws a sentinel so the client stops before `createAuthorization`,
 * which does storage and PKCE work this has no opinion about.
 */
const sentinel = new Error('receiver reached')

const popupReceiver = vi.fn(
  (_options?: PopupReceiverOptions): CallbackReceiver => ({
    id: 'popup',
    start: () => {
      throw sentinel
    },
  }),
)

vi.mock('../src/popup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/popup.js')>()),
  popupReceiver: (...args: Parameters<typeof popupReceiver>) => popupReceiver(...args),
}))

const { loginWithPopup } = await import('../src/index.js')

const provider: ProviderConfig = defineProvider({
  id: 'login-with-popup-test',
  label: 'Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
})

/** The options `popupReceiver` was constructed with on the one call made. */
async function receiverOptionsFrom(run: Promise<unknown>) {
  await expect(run).rejects.toThrow(sentinel)
  expect(popupReceiver).toHaveBeenCalledOnce()

  return popupReceiver.mock.calls[0]?.[0] ?? {}
}

afterEach(() => {
  popupReceiver.mockClear()
})

describe('loginWithPopup', () => {
  /**
   * The one that motivated this. An app whose own pages carry
   * `Cross-Origin-Opener-Policy: same-origin` has its popup handle disowned on
   * the popup's first cross-origin navigation, so every sign-in rejects as
   * `aborted` while the user is still on the login form. `pollForClose: false`
   * is the answer, and it is worth nothing if the documented entry point drops
   * it on the floor.
   */
  it('forwards pollForClose to the receiver', async () => {
    const options = await receiverOptionsFrom(
      loginWithPopup(provider, { clientId: 'test-client', pollForClose: false }),
    )

    expect(options).toMatchObject({ pollForClose: false })
  })

  it('forwards every popup option, not just redirectUri', async () => {
    const options = await receiverOptionsFrom(
      loginWithPopup(provider, {
        clientId: 'test-client',
        redirectUri: 'https://app.test/callback',
        width: 900,
        height: 700,
        windowName: 'named',
        pollIntervalMs: 25,
        pollForClose: true,
      }),
    )

    expect(options).toEqual({
      redirectUri: 'https://app.test/callback',
      width: 900,
      height: 700,
      windowName: 'named',
      pollIntervalMs: 25,
      pollForClose: true,
    })
  })

  /**
   * An option nobody passed must stay unpassed rather than arrive as an
   * explicit `undefined`. The receiver reads `pollForClose !== false`, which an
   * `undefined` would survive, but `width ?? 520` and a future `!== undefined`
   * test would not agree about it — so the absence is asserted rather than the
   * behaviour that currently papers over it.
   */
  it('passes no key for an option the caller left out', async () => {
    const options = await receiverOptionsFrom(loginWithPopup(provider, { clientId: 'test-client' }))

    expect(options).toEqual({})
  })
})
