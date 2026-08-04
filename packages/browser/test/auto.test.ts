// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { autoReceiver, type AutoReceiverOptions } from '../src/auto.js'
import type { BrowserOrigin } from '../src/flow.js'

type PromptFn = NonNullable<AutoReceiverOptions['prompt']>

const httpsOrigin: BrowserOrigin = { protocol: 'https:', hostname: 'app.example.com', port: '' }

/** Resolves to popup on `httpsOrigin`: non-loopback, acceptsHttpsRedirect. */
const popupProvider: ProviderConfig = defineProvider({
  id: 'popup-test',
  label: 'Popup Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'custom', acceptsHttpsRedirect: true },
})

/** Accepts any loopback port — resolves to popup on jsdom's default loopback origin too. */
const loopbackPopupProvider: ProviderConfig = defineProvider({
  id: 'loopback-popup-test',
  label: 'Loopback Popup Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'loopback', loopbackPort: 0 },
})

/** Resolves to device on `httpsOrigin`: no redirect this origin can use, device declared. */
const deviceProvider: ProviderConfig = defineProvider({
  id: 'device-test',
  label: 'Device Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  deviceAuthorizationUrl: 'https://provider.test/device',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
})

/**
 * Resolves to paste on `httpsOrigin`: no redirect this origin can use, no
 * device either. `mode: 'loopback'` with no fixed port, not `'custom'` — a
 * truly redirect-less provider (github-copilot, qwen) can't be pasted either,
 * since `manualReceiver` has nothing to synthesise a redirect URI from.
 */
const pasteProvider: ProviderConfig = defineProvider({
  id: 'paste-test',
  label: 'Paste Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'loopback' },
})

interface FakePopup {
  closed: boolean
  close: () => void
}

let popup: FakePopup
let openSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  popup = { closed: false, close: vi.fn(() => void (popup.closed = true)) }
  openSpy = vi.fn(() => popup)
  vi.stubGlobal('open', openSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('autoReceiver — popup resolution', () => {
  it('delegates to popupReceiver with the resolved redirect URI', async () => {
    const started = await autoReceiver({ origin: httpsOrigin }).start({ provider: popupProvider })

    // originRoot(httpsOrigin), not window.location — the whole point of passing origin.
    expect(started.redirectUri).toBe('https://app.example.com/')

    const waiting = started.wait()
    await started.present('https://provider.test/authorize?x=1')
    expect(openSpy).toHaveBeenCalledOnce()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'aioauth:callback', payload: '?code=abc&state=xyz' },
        origin: window.location.origin,
      }),
    )
    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'xyz' })

    await started.close()
  })

  it('forwards popup options such as window sizing', async () => {
    const started = await autoReceiver({
      origin: httpsOrigin,
      popup: { windowName: 'my-popup' },
    }).start({ provider: popupProvider })

    await started.present('https://provider.test/authorize')
    expect(openSpy.mock.calls[0]?.[1]).toBe('my-popup')

    await started.close()
  })

  it('defaults its origin to window.location when none is given', async () => {
    // jsdom's default location is http://localhost/ — loopback, so this only
    // proves the default origin came from `window.location` if the provider
    // needs a loopback match to resolve to popup at all.
    const started = await autoReceiver().start({ provider: loopbackPopupProvider })
    expect(started.redirectUri).toBe('http://localhost/')
    await started.close()
  })
})

describe('autoReceiver — device resolution', () => {
  it('refuses a device-only provider, naming deviceLogin()', async () => {
    await expect(autoReceiver({ origin: httpsOrigin }).start({ provider: deviceProvider })).rejects.toMatchObject(
      { code: 'configuration_error' },
    )
    await expect(
      autoReceiver({ origin: httpsOrigin }).start({ provider: deviceProvider }),
    ).rejects.toThrow(/deviceLogin/)
  })

  it('fails before any UI is shown — window.open is never called', async () => {
    await autoReceiver({ origin: httpsOrigin }).start({ provider: deviceProvider }).catch(() => {})
    expect(openSpy).not.toHaveBeenCalled()
  })
})

describe('autoReceiver — paste resolution', () => {
  it('delegates to manualReceiver and threads the hint through to prompt()', async () => {
    const prompt = vi.fn<PromptFn>(async () => '?code=pasted&state=xyz')
    const started = await autoReceiver({ origin: httpsOrigin, prompt }).start({ provider: pasteProvider })

    await started.present('https://provider.test/authorize?x=1')
    expect(prompt).toHaveBeenCalledOnce()
    const [url, hint] = prompt.mock.calls[0]!
    expect(url).toBe('https://provider.test/authorize?x=1')
    expect(hint.kind).toBe('unreachable')

    await expect(started.wait()).resolves.toEqual({ code: 'pasted', state: 'xyz' })
  })

  it('refuses a paste-only provider when no prompt was supplied', async () => {
    await expect(
      autoReceiver({ origin: httpsOrigin }).start({ provider: pasteProvider }),
    ).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(
      autoReceiver({ origin: httpsOrigin }).start({ provider: pasteProvider }),
    ).rejects.toThrow(/prompt/)
  })
})
