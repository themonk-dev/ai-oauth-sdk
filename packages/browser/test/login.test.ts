// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAuthClient, defineProvider, type ProviderConfig, type TokenSet } from '@ai-oauth-sdk/core'

import { autoLogin } from '../src/login.js'
import type { BrowserOrigin } from '../src/flow.js'

const httpsOrigin: BrowserOrigin = { protocol: 'https:', hostname: 'app.example.com', port: '' }

const popupProvider: ProviderConfig = defineProvider({
  id: 'browser-login-popup',
  label: 'Popup Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'custom', acceptsHttpsRedirect: true },
})

const deviceProvider: ProviderConfig = defineProvider({
  id: 'browser-login-device',
  label: 'Device Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  deviceAuthorizationUrl: 'https://provider.test/device',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
})

const fakeTokens: TokenSet = {
  accessToken: 'access-1',
  tokenType: 'Bearer',
  provider: 'browser-login-test',
  raw: {},
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('autoLogin — popup/paste providers', () => {
  it('runs client.login() through autoReceiver, not deviceLogin()', async () => {
    const client = createAuthClient({ provider: popupProvider })
    const login = vi.spyOn(client, 'login').mockResolvedValue(fakeTokens)
    const deviceLogin = vi.spyOn(client, 'deviceLogin')

    const tokens = await autoLogin(client, { origin: httpsOrigin })

    expect(tokens).toBe(fakeTokens)
    expect(login).toHaveBeenCalledOnce()
    expect(deviceLogin).not.toHaveBeenCalled()

    const passedReceiver = login.mock.calls[0]?.[0]?.receiver
    expect(passedReceiver?.id).toBe('auto')
  })

  it('forwards scopes, signal, timeout, extraParams and metadata to login()', async () => {
    const client = createAuthClient({ provider: popupProvider })
    const login = vi.spyOn(client, 'login').mockResolvedValue(fakeTokens)
    const controller = new AbortController()

    await autoLogin(client, {
      origin: httpsOrigin,
      scopes: ['a', 'b'],
      signal: controller.signal,
      timeoutMs: 5000,
      extraParams: { foo: 'bar' },
      metadata: { source: 'test' },
    })

    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ['a', 'b'],
        signal: controller.signal,
        timeoutMs: 5000,
        extraParams: { foo: 'bar' },
        metadata: { source: 'test' },
      }),
    )
  })
})

describe('autoLogin — device-only providers', () => {
  it('runs client.deviceLogin(), not client.login()', async () => {
    const client = createAuthClient({ provider: deviceProvider })
    const login = vi.spyOn(client, 'login')
    const deviceLogin = vi.spyOn(client, 'deviceLogin').mockResolvedValue(fakeTokens)
    const onCode = vi.fn()

    const tokens = await autoLogin(client, { origin: httpsOrigin, onCode })

    expect(tokens).toBe(fakeTokens)
    expect(login).not.toHaveBeenCalled()
    expect(deviceLogin).toHaveBeenCalledOnce()
    expect(deviceLogin.mock.calls[0]?.[0]?.onCode).toBe(onCode)
  })

  it('forwards scopes and signal to deviceLogin()', async () => {
    const client = createAuthClient({ provider: deviceProvider })
    const deviceLogin = vi.spyOn(client, 'deviceLogin').mockResolvedValue(fakeTokens)
    const controller = new AbortController()
    const onCode = vi.fn()

    await autoLogin(client, {
      origin: httpsOrigin,
      onCode,
      scopes: ['x'],
      signal: controller.signal,
    })

    expect(deviceLogin).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['x'], signal: controller.signal, onCode }),
    )
  })

  it('refuses to run the device grant blind, before calling deviceLogin at all', async () => {
    const client = createAuthClient({ provider: deviceProvider })
    const deviceLogin = vi.spyOn(client, 'deviceLogin')

    await expect(autoLogin(client, { origin: httpsOrigin })).rejects.toMatchObject({
      code: 'configuration_error',
    })
    await expect(autoLogin(client, { origin: httpsOrigin })).rejects.toThrow(/onCode/)
    expect(deviceLogin).not.toHaveBeenCalled()
  })
})
