import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { providerFromDiscovery } from '../src/providers/index.js'
import { manualReceiver } from '../src/receivers/manual.js'
import { defineProvider } from '../src/providers/define.js'
import type { FetchLike, ProviderConfig } from '../src/types.js'

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

  // A discovery document is remote input. An http token_endpoint there would put
  // the refresh token and client secret on the wire in cleartext without anyone
  // typing an http URL, which is why these are rejected here but tolerated in
  // hand-written `defineProvider` config.
  it('rejects a document naming an http token_endpoint', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'http://acme.test/token',
    })

    await expect(
      providerFromDiscovery(issuer, { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } }),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/token_endpoint.*"http:\/\/acme\.test\/token"/),
    })
  })

  it('rejects a document naming an http authorization_endpoint', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'http://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
    })

    await expect(
      providerFromDiscovery(issuer, { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } }),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/authorization_endpoint.*"http:\/\/acme\.test\/authorize"/),
    })
  })

  it('rejects a document naming an http device_authorization_endpoint', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
      device_authorization_endpoint: 'http://acme.test/device',
    })

    await expect(
      providerFromDiscovery(issuer, { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } }),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/device_authorization_endpoint.*"http:\/\/acme\.test\/device"/),
    })
  })

  it('rejects a document endpoint that is not a URL at all', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: '/token',
    })

    await expect(
      providerFromDiscovery(issuer, { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } }),
    ).rejects.toThrowError(/token_endpoint that is not a valid URL: "\/token"/)
  })

  it('accepts http loopback endpoints, which never reach a wire', async () => {
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'http://127.0.0.1:8123/authorize',
      token_endpoint: 'http://localhost:8123/token',
      device_authorization_endpoint: 'http://[::1]:8123/device',
    })

    const provider = await providerFromDiscovery(issuer, {
      id: 'acme',
      label: 'Acme',
      redirect: { mode: 'loopback' },
    })

    expect(provider.authorizationUrl).toBe('http://127.0.0.1:8123/authorize')
    expect(provider.tokenUrl).toBe('http://localhost:8123/token')
    expect(provider.deviceAuthorizationUrl).toBe('http://[::1]:8123/device')
  })

  it('leaves an integrator-supplied http tokenUrl alone', async () => {
    // Not document-sourced, so it is the integrator's own config — the same
    // value `defineProvider` would accept without comment.
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
    })

    const provider = await providerFromDiscovery(issuer, {
      id: 'acme',
      label: 'Acme',
      tokenUrl: 'http://internal-gateway.acme.test/token',
      redirect: { mode: 'loopback' },
    })
    expect(provider.tokenUrl).toBe('http://internal-gateway.acme.test/token')
  })

  // The issuer is the transport the document arrives over, so it needs the same
  // rule as the values inside it — the loopback issuers every test above builds
  // are exactly the exemption that keeps working.
  it('refuses a cleartext issuer without fetching anything', async () => {
    const requested: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      requested.push(input)

      throw new Error('discovery must not be fetched over cleartext')
    }

    await expect(
      providerFromDiscovery(
        'http://sso.corp.internal',
        { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/"http:\/\/sso\.corp\.internal"/),
    })
    // The check has to precede the request: by the time a response exists, the
    // client has already announced itself to whoever is on the path.
    expect(requested).toEqual([])
  })

  it('closes the on-path swap of https endpoints served over an http issuer', async () => {
    // The endpoints below are https, so the document-value guard passes them
    // happily. Only the issuer check catches this, and without it the
    // descriptor would carry the attacker's token endpoint for its whole life.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: 'https://evil.example/authorize',
          token_endpoint: 'https://evil.example/token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    await expect(
      providerFromDiscovery(
        'http://sso.corp.internal',
        { id: 'acme', label: 'Acme', clientSecret: 'super-secret', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('accepts an https issuer', async () => {
    const fetchImpl: FetchLike = async (input) => {
      expect(input).toBe('https://acme.test/.well-known/openid-configuration')

      return new Response(
        JSON.stringify({
          authorization_endpoint: 'https://acme.test/authorize',
          token_endpoint: 'https://acme.test/token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    await expect(
      providerFromDiscovery(
        'https://acme.test',
        { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ tokenUrl: 'https://acme.test/token' })
  })

  it('refuses an issuer that is not a URL at all', async () => {
    await expect(
      providerFromDiscovery('sso.corp.internal', {
        id: 'acme',
        label: 'Acme',
        redirect: { mode: 'loopback' },
      }),
    ).rejects.toThrowError(/issuer is not a valid URL: "sso\.corp\.internal"/)
  })

  // `fetch` follows redirects, and outside a browser nothing bars an https→http
  // hop. Checking only the issuer therefore constrains where the request went,
  // not where the document came from — and it is the document that names the
  // endpoints. A stub `Response` cannot be given a `url` by its constructor, so
  // these define one, which is exactly what a redirected real response carries.
  const servedFrom = (finalUrl: string, document: unknown): Response => {
    const response = new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    Object.defineProperty(response, 'url', { value: finalUrl })

    return response
  }

  const hostileDocument = {
    authorization_endpoint: 'https://evil.example/authorize',
    token_endpoint: 'https://evil.example/token',
  }

  it('refuses a document redirected down to cleartext', async () => {
    // The endpoints are https, so every later check passes them. Only the
    // scheme of the URL the document was actually served from catches this.
    const fetchImpl: FetchLike = async () =>
      servedFrom('http://sso.corp.example/.well-known/openid-configuration', hostileDocument)

    await expect(
      providerFromDiscovery(
        'https://idp.acme.example',
        { id: 'acme', label: 'Acme', clientSecret: 'super-secret', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      code: 'configuration_error',
      message: expect.stringMatching(/redirected to an unusable URL/),
    })
  })

  it('refuses a public issuer redirected onto loopback', async () => {
    // The loopback exemption is for a local development issuer redirecting
    // within itself. Arriving on loopback after starting at a public https
    // issuer is not that: it hands the choice of endpoints to whatever local
    // process holds the port.
    const fetchImpl: FetchLike = async () =>
      servedFrom('http://127.0.0.1:9999/.well-known/openid-configuration', hostileDocument)

    await expect(
      providerFromDiscovery(
        'https://idp.acme.example',
        { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('refuses a final URL it cannot parse', async () => {
    // The issuer and endpoint checks both refuse an unparseable URL. A value we
    // cannot read is not one we can vouch for, so this one does too rather than
    // falling through.
    const fetchImpl: FetchLike = async () => servedFrom('not a url at all', hostileDocument)

    await expect(
      providerFromDiscovery(
        'https://idp.acme.example',
        { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('allows a redirect that stays on https', async () => {
    // Path normalisation and a hop to a separate identity host are both
    // ordinary. The check is on the scheme alone precisely so they keep working
    // — requiring the final origin to match the issuer would break them.
    for (const finalUrl of [
      'https://idp.acme.example/.well-known/openid-configuration/',
      'https://login.acme.example/.well-known/openid-configuration',
    ]) {
      const fetchImpl: FetchLike = async () =>
        servedFrom(finalUrl, {
          authorization_endpoint: 'https://acme.test/authorize',
          token_endpoint: 'https://acme.test/token',
        })

      await expect(
        providerFromDiscovery(
          'https://idp.acme.example',
          { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } },
          fetchImpl,
        ),
      ).resolves.toMatchObject({ tokenUrl: 'https://acme.test/token' })
    }
  })

  it('leaves a hand-built response with no url alone', async () => {
    // A `FetchLike` returning a constructed `Response` reports `url` as '', and
    // a test double should not have to fake one to stay working.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: 'https://acme.test/authorize',
          token_endpoint: 'https://acme.test/token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    await expect(
      providerFromDiscovery(
        'https://acme.test',
        { id: 'acme', label: 'Acme', redirect: { mode: 'loopback' } },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ tokenUrl: 'https://acme.test/token' })
  })

  it('follows a real redirect between loopback hosts', async () => {
    // End to end through the platform `fetch`, so `response.url` is the real
    // one rather than a defined property. Cleartext on loopback keeps the same
    // exemption every other check here gives it.
    const target = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'https://acme.test/token',
    })
    const redirector = createServer((request, response) => {
      response.writeHead(302, { Location: `${target}${request.url}` })
      response.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    const issuer = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`

    try {
      await expect(
        providerFromDiscovery(issuer, {
          id: 'acme',
          label: 'Acme',
          redirect: { mode: 'loopback' },
        }),
      ).resolves.toMatchObject({ tokenUrl: 'https://acme.test/token' })
    } finally {
      await new Promise<void>((resolve) => {
        redirector.close(() => resolve())
        redirector.closeAllConnections?.()
      })
    }
  })

  it('still checks the document when an endpoint is passed as null', async () => {
    // `??` falls through on `null` as well as `undefined`, so the document's
    // value wins here. A guard testing only for `undefined` would skip the
    // check on exactly the value it is meant to cover. TypeScript rejects
    // `null`, but a JS consumer — or a JSON config with an unset optional key
    // — produces it.
    const issuer = await startDiscoveryServer({
      authorization_endpoint: 'https://acme.test/authorize',
      token_endpoint: 'http://attacker.test/token',
    })

    await expect(
      providerFromDiscovery(issuer, {
        id: 'acme',
        label: 'Acme',
        tokenUrl: null as unknown as undefined,
        redirect: { mode: 'loopback' },
      }),
    ).rejects.toMatchObject({ code: 'configuration_error' })
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

  it("parses Claude's code#state paste", async () => {
    const { claude } = await import('../src/providers/claude.js')
    const started = await manualReceiver({ prompt: async () => 'thecode#thestate' }).start({
      provider: claude,
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
