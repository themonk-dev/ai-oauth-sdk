// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { popupReceiver, postCallbackToOpener } from '../src/popup.js'

const provider: ProviderConfig = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
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

/** Delivers a message the way the redirect page's postMessage would. */
function deliverCallback(payload: string, origin = window.location.origin) {
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'aioauth:callback', payload }, origin }),
  )
}

describe('popupReceiver', () => {
  it('opens a popup and resolves when the callback arrives', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()

    await started.present('https://provider.test/authorize?x=1')
    expect(openSpy).toHaveBeenCalledOnce()
    expect(openSpy.mock.calls[0]?.[0]).toBe('https://provider.test/authorize?x=1')

    deliverCallback('?code=abc&state=xyz')
    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'xyz' })

    await started.close()
  })

  it('ignores messages from another origin', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    // A hostile frame must not be able to inject an authorization code.
    deliverCallback('?code=attacker&state=xyz', 'https://evil.test')

    const outcome = await Promise.race([
      waiting.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('ignored'), 50)),
    ])
    expect(outcome).toBe('ignored')

    await started.close()
  })

  it('ignores unrelated messages on the same origin', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'something-else' }, origin: window.location.origin }),
    )
    window.dispatchEvent(new MessageEvent('message', { data: null, origin: window.location.origin }))

    const outcome = await Promise.race([
      waiting.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('ignored'), 50)),
    ])
    expect(outcome).toBe('ignored')

    await started.close()
  })

  it('rejects when the user closes the popup', async () => {
    const started = await popupReceiver({
      redirectUri: 'http://localhost/callback',
      pollIntervalMs: 10,
    }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    popup.closed = true
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })

    await started.close()
  })

  it('reports a blocked popup with actionable advice', async () => {
    openSpy.mockReturnValue(null)
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })

    await expect(started.present('https://provider.test/authorize')).rejects.toMatchObject({
      code: 'unsupported_runtime',
    })
    await expect(started.present('https://provider.test/authorize')).rejects.toThrow(/user gesture/)
  })

  it('surfaces a provider denial', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    deliverCallback('?error=access_denied&error_description=nope')
    await expect(waiting).rejects.toMatchObject({
      code: 'authorization_denied',
      providerError: 'access_denied',
    })

    await started.close()
  })

  it('closes the popup and stops listening on close()', async () => {
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({ provider })
    await started.present('https://provider.test/authorize')
    await started.close()

    expect(popup.close).toHaveBeenCalled()
  })

  it('aborts on signal', async () => {
    const controller = new AbortController()
    const started = await popupReceiver({ redirectUri: 'http://localhost/callback' }).start({
      provider,
      signal: controller.signal,
    })
    const waiting = started.wait()
    await started.present('https://provider.test/authorize')

    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
  })

  it('defaults its redirect URI to the current page', async () => {
    const started = await popupReceiver().start({ provider })
    expect(started.redirectUri).toBe('http://localhost/')
  })
})

describe('postCallbackToOpener', () => {
  afterEach(() => {
    Object.defineProperty(window, 'opener', { value: null, configurable: true })
  })

  it('posts to the opener and reports success', () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'opener', { value: { postMessage }, configurable: true })
    vi.spyOn(window, 'close').mockImplementation(() => {})

    expect(postCallbackToOpener('?code=abc&state=xyz')).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'aioauth:callback', payload: '?code=abc&state=xyz' },
      window.location.origin,
    )
  })

  it('returns false when the page has no opener', () => {
    // Someone navigated to the callback page directly.
    expect(postCallbackToOpener('?code=abc')).toBe(false)
  })

  it('targets its own origin, never a wildcard', () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'opener', { value: { postMessage }, configurable: true })
    vi.spyOn(window, 'close').mockImplementation(() => {})

    postCallbackToOpener('?code=abc')
    // A '*' target would leak the authorization code to any listener.
    expect(postMessage.mock.calls[0]?.[1]).toBe(window.location.origin)
    expect(postMessage.mock.calls[0]?.[1]).not.toBe('*')
  })
})
