import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { providerFromDiscovery } from '../src/providers/index.js'
import { manualReceiver } from '../src/receivers/manual.js'
import { defineProvider } from '../src/providers/define.js'
import type { ProviderConfig } from '../src/types.js'

let server: Server | undefined

async function startDiscoveryServer(document: unknown, status = 200): Promise<string> {
  server = createServer((request, response) => {
    if (request.url === '/.well-known/openid-configuration') {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(document))

      return
    }

    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))

  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve())
      // Undici holds the connection open for reuse, and `close()` waits for it
      // — five seconds per test on Node 18 without this.
      server!.closeAllConnections?.()
    })
    server = undefined
  }
})

describe('providerFromDiscovery', () => {
  it('builds a provider from an OIDC document', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
      device_authorization_endpoint: 'https://acme.test/device',
      scopes_supported: ['openid', 'email'],
    })

    const provider = await providerFromDiscovery(issuer, {
      id: 'acme',
      label: 'Acme',
      clientId: 'acme-client',
      redirect: { mode: 'loopback', loopbackPort: 0 },
    })

    expect(provider.authorizationUrl).toBe('https://acme.test/authorize')
    expect(provider.tokenUrl).toBe('https://acme.test/token')
    expect(provider.deviceAuthorizationUrl).toBe('https://acme.test/device')
    expect(provider.scopes).toEqual(['openid', 'email'])
    // defineProvider's conventions still apply.
    expect(provider.usePkce).toBe(true)
    expect(provider.pkceMethod).toBe('S256')
  })

  it('tolerates a trailing slash on the issuer', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
    })

    await expect(
      providerFromDiscovery(`${issuer}/`, {
        id: 'acme',
        label: 'Acme',
        redirect: { mode: 'loopback' },
      }),
    ).resolves.toMatchObject({ tokenUrl: 'https://acme.test/token' })
  })

  it('lets explicit endpoints override the document', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
    })

    const provider = await providerFromDiscovery(issuer, {
      id: 'acme',
      label: 'Acme',
      tokenUrl: 'https://override.test/token',
      redirect: { mode: 'loopback' },
    })
    expect(provider.tokenUrl).toBe('https://override.test/token')
  })

  it('defaults scopes to openid when the document lists none', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
    })

    const provider = await providerFromDiscovery(issuer, {
      id: 'acme',
      label: 'Acme',
      redirect: { mode: 'loopback' },
    })
    expect(provider.scopes).toEqual(['openid'])
  })

  it('reports an HTTP failure', async () => {
    const issuer = await startDiscoveryServer({}, 500)
    await expect(
      providerFromDiscovery(issuer, { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } }),
    ).rejects.toMatchObject({ code: 'configuration_error', status: 500 })
  })

  it('reports a document missing required endpoints', async () => {
    const issuer = await startDiscoveryServer({ issuer: 'https://acme.test' })
    await expect(
      providerFromDiscovery(issuer, { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } }),
    ).rejects.toThrowError(/missing authorization_endpoint or token_endpoint/)
  })
})

describe('manualReceiver', () => {
  const provider: ProviderConfig = defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'c',
    authorizationUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    scopes: [],
    redirect: { mode: 'hosted', hostedUri: 'https://provider.test/callback' },
  })

  it('uses the provider hosted URI by default', async () => {
    const started = await manualReceiver({ prompt: async () => 'code#state' }).start({ provider })
    expect(started.redirectUri).toBe('https://provider.test/callback')
  })

  it('accepts an explicit redirect URI', async () => {
    const started = await manualReceiver({
      prompt: async () => 'abc',
      redirectUri: 'https://custom.test/cb',
    }).start({ provider })
    expect(started.redirectUri).toBe('https://custom.test/cb')
  })

  it('synthesises a loopback URI when the provider has no hosted one', async () => {
    // Pasting is the fallback for headless machines, and most providers are
    // loopback — so refusing them here made `--paste` useless for all but one.
    // The browser cannot reach the port, which is the point: the user copies
    // the code out of the address bar.
    const loopbackOnly = defineProvider({
      ...provider,
      redirect: { mode: 'loopback', loopbackPort: 0 },
    })
    const started = await manualReceiver({ prompt: async () => 'abc' }).start({
      provider: loopbackOnly,
    })
    expect(started.redirectUri).toMatch(/^http:\/\/localhost:\d+\//)
    expect(started.redirectUri).not.toContain(':0/')
  })

  it('refuses a provider that has no redirect at all', async () => {
    const deviceOnly = defineProvider({ ...provider, redirect: { mode: 'custom' } })
    await expect(
      manualReceiver({ prompt: async () => 'abc' }).start({ provider: deviceOnly }),
    ).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('parses a pasted full URL', async () => {
    const started = await manualReceiver({
      prompt: async () => 'https://provider.test/callback?code=abc&state=xyz',
    }).start({ provider })

    await started.present('https://provider.test/authorize')
    await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'xyz' })
  })

  it("parses Anthropic's code#state paste", async () => {
    const { anthropic } = await import('../src/providers/anthropic.js')
    const started = await manualReceiver({ prompt: async () => 'thecode#thestate' }).start({
      provider: anthropic,
    })

    await started.present('https://claude.ai/oauth/authorize')
    await expect(started.wait()).resolves.toEqual({ code: 'thecode', state: 'thestate' })
  })

  it('trims whitespace from the paste', async () => {
    const started = await manualReceiver({
      prompt: async () => '  https://provider.test/callback?code=abc&state=xyz  \n',
    }).start({ provider })

    await started.present('https://provider.test/authorize')
    await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'xyz' })
  })

  it('rejects a paste with no code in it', async () => {
    const started = await manualReceiver({ prompt: async () => 'https://provider.test/callback' }).start(
      { provider },
    )

    await started.present('https://provider.test/authorize')
    await expect(started.wait()).rejects.toMatchObject({ code: 'invalid_token_response' })
  })

  it('surfaces a pasted error response', async () => {
    const started = await manualReceiver({
      prompt: async () => 'https://provider.test/callback?error=access_denied',
    }).start({ provider })

    await started.present('https://provider.test/authorize')
    await expect(started.wait()).rejects.toMatchObject({ code: 'authorization_denied' })
  })

  it('requires present() before wait()', async () => {
    const started = await manualReceiver({ prompt: async () => 'abc' }).start({ provider })
    await expect(started.wait()).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('passes the authorization URL to the prompt and to openUrl', async () => {
    const seen: string[] = []
    const opened: string[] = []
    const started = await manualReceiver({
      prompt: async (url) => {
        seen.push(url)

        return 'https://provider.test/callback?code=abc'
      },
    }).start({ provider, openUrl: (url) => void opened.push(url) })

    await started.present('https://provider.test/authorize?x=1')
    expect(seen).toEqual(['https://provider.test/authorize?x=1'])
    expect(opened).toEqual(['https://provider.test/authorize?x=1'])
  })

  it('does not leak an unhandled rejection when wait() is never called', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)

    try {
      const started = await manualReceiver({ prompt: async () => 'garbage' }).start({ provider })
      // present() fails to parse, and the caller walks away without waiting.
      await started.present('https://provider.test/authorize')
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
