import { describe, expect, it } from 'vitest'

import { defineProvider, providers, type BuiltInProviderId, type ProviderConfig } from '@ai-oauth-sdk/core'

import { resolveBrowserFlow, type BrowserFlowResolution, type BrowserOrigin } from '../src/flow.js'

/** A dev server on an arbitrary port — not any built-in provider's fixed port. */
const loopbackOrigin: BrowserOrigin = { protocol: 'http:', hostname: 'localhost', port: '5173' }

/** A deployed app, the shape every non-loopback consumer actually runs from. */
const httpsOrigin: BrowserOrigin = { protocol: 'https:', hostname: 'app.example.com', port: '' }

/**
 * A non-loopback *cleartext* origin. Not a contrived case: an app on the LAN
 * during development, or an intranet tool behind a name with no certificate.
 */
const cleartextOrigin: BrowserOrigin = { protocol: 'http:', hostname: 'tools.corp.lan', port: '' }

/**
 * The same dev server reached over IPv6. `location.hostname` keeps the brackets
 * an IPv6 host is written with, so this is the spelling a real `Location`
 * produces — and the one the loopback set has to hold for it to be recognised.
 */
const ipv6LoopbackOrigin: BrowserOrigin = { protocol: 'http:', hostname: '[::1]', port: '5173' }

function expectPopup(resolution: BrowserFlowResolution): asserts resolution is Extract<
  BrowserFlowResolution,
  { flow: 'popup' }
> {
  expect(resolution.flow).toBe('popup')
}

function expectPaste(resolution: BrowserFlowResolution): asserts resolution is Extract<
  BrowserFlowResolution,
  { flow: 'paste' }
> {
  expect(resolution.flow).toBe('paste')
}

/**
 * What each built-in provider resolves to, per the design note's matrix —
 * derived from the rule, not hardcoded, so this is what stops a descriptor
 * edit silently changing which flow a consumer gets.
 */
const MATRIX: Array<[BuiltInProviderId, BrowserFlowResolution['flow'], BrowserFlowResolution['flow']]> = [
  ['openrouter', 'popup', 'popup'],
  // Claude and Gemini agree everywhere: a loopback origin is itself a
  // registered redirect for a client declaring `loopbackPort: 0`, and neither
  // client will complete a grant against an HTTPS one.
  ['claude', 'popup', 'paste'],
  ['gemini', 'popup', 'paste'],
  ['openai', 'device', 'device'],
  ['xai', 'device', 'device'],
  ['github-copilot', 'device', 'device'],
  ['qwen', 'device', 'device'],
]

describe.each(MATRIX)('%s', (id, loopbackFlow, httpsFlow) => {
  const provider = providers[id]

  it(`resolves to "${loopbackFlow}" on a loopback origin`, () => {
    expect(resolveBrowserFlow(provider, loopbackOrigin).flow).toBe(loopbackFlow)
  })

  it(`resolves to "${httpsFlow}" on an HTTPS origin`, () => {
    expect(resolveBrowserFlow(provider, httpsOrigin).flow).toBe(httpsFlow)
  })
})

describe('popup redirect URIs', () => {
  it('offers the origin itself for a provider that accepts any loopback port', () => {
    // openrouter and claude both declare loopbackPort: 0.
    const resolution = resolveBrowserFlow(providers.openrouter, loopbackOrigin)
    expectPopup(resolution)
    expect(resolution.redirectUri).toBe('http://localhost:5173/')
  })

  it('offers the origin itself for a provider that accepts an arbitrary HTTPS redirect', () => {
    // OpenRouter identifies an app by the callback URL it is handed, so any
    // URL is a registered one — see providers/openrouter.ts.
    const resolution = resolveBrowserFlow(providers.openrouter, httpsOrigin)
    expectPopup(resolution)
    expect(resolution.redirectUri).toBe('https://app.example.com/')
  })

  it('resolves the provider-exact URI when served from openai’s fixed loopback port', () => {
    // The free case: an app happening to run on exactly localhost:1455
    // satisfies OpenAI's fixed redirect without OpenAI accepting anything else.
    const origin: BrowserOrigin = { protocol: 'http:', hostname: 'localhost', port: '1455' }
    const resolution = resolveBrowserFlow(providers.openai, origin)
    expectPopup(resolution)
    expect(resolution.redirectUri).toBe('http://localhost:1455/auth/callback')
  })

  it('does not treat a mismatched loopback port or host as satisfying a fixed redirect', () => {
    // xai wants 127.0.0.1:56121 specifically; the same port on `localhost` is
    // a different host as far as a registered redirect is concerned.
    const wrongHost: BrowserOrigin = { protocol: 'http:', hostname: 'localhost', port: '56121' }
    expect(resolveBrowserFlow(providers.xai, wrongHost).flow).toBe('device')

    const wrongPort: BrowserOrigin = { protocol: 'http:', hostname: '127.0.0.1', port: '3000' }
    expect(resolveBrowserFlow(providers.xai, wrongPort).flow).toBe('device')

    const exact: BrowserOrigin = { protocol: 'http:', hostname: '127.0.0.1', port: '56121' }
    expect(resolveBrowserFlow(providers.xai, exact).flow).toBe('popup')
  })
})

/*
 * `acceptsHttpsRedirect` says what the provider will take, and rule 1 used to
 * test only "not loopback" while `originRoot` copies `origin.protocol`
 * verbatim. An app served from `http://tools.corp.lan/` therefore had that
 * cleartext URL handed to the provider as its redirect — for `openrouter` it
 * reaches the wire as `callback_url` — and the authorization code came back
 * over cleartext.
 */
describe('a non-loopback cleartext origin', () => {
  it('is never offered a popup by the provider that accepts an arbitrary HTTPS redirect', () => {
    expect(providers.openrouter.redirect.acceptsHttpsRedirect).toBe(true)
    expect(resolveBrowserFlow(providers.openrouter, cleartextOrigin).flow).not.toBe('popup')
  })

  it('never yields an http redirect URI from any built-in provider', () => {
    for (const provider of Object.values(providers)) {
      const resolution = resolveBrowserFlow(provider, cleartextOrigin)

      if (resolution.flow === 'popup') {
        expect.unreachable(`${provider.id} offered a popup from a cleartext origin`)
      }
    }
  })

  it('is told the origin has to be secure, not that the page will fail to load', () => {
    const resolution = resolveBrowserFlow(providers.openrouter, cleartextOrigin)
    expectPaste(resolution)
    // The `unreachable` wording — "will fail to load", "copy the whole address
    // bar" — describes something that does not happen here, and names a remedy
    // that is not the one. The redirect address is fine; the origin is not.
    expect(resolution.hint.kind).toBe('insecure-origin')
    expect(resolution.hint.message).toMatch(/https/)
  })

  it('still prefers a device flow, which needs no redirect back to the page at all', () => {
    // openai and xai are unaffected by the origin's scheme: nothing is
    // redirected anywhere, so downgrading them to paste would be a regression.
    expect(resolveBrowserFlow(providers.openai, cleartextOrigin).flow).toBe('device')
    expect(resolveBrowserFlow(providers.xai, cleartextOrigin).flow).toBe('device')
  })

  it('leaves loopback origins alone, where cleartext never leaves the machine', () => {
    // Rule 2 catches these on `loopbackPort: 0`, and must keep doing so.
    const resolution = resolveBrowserFlow(providers.openrouter, loopbackOrigin)
    expectPopup(resolution)
    expect(resolution.redirectUri).toBe('http://localhost:5173/')

    const ipLiteral: BrowserOrigin = { protocol: 'http:', hostname: '127.0.0.1', port: '3000' }
    expectPopup(resolveBrowserFlow(providers.claude, ipLiteral))
  })

  /*
   * The bracketed spelling is the one a real `Location` hands over, so a
   * loopback set holding a bare `::1` recognises no IPv6 origin at all. That
   * was survivable while rule 1 caught everything cleartext; now that rule 1
   * requires https, an unrecognised `[::1]` would drop a dev server from
   * `popup` to a paste hint telling it to be served over https — advice that
   * makes no sense for a machine talking to itself.
   */
  it('recognises the bracketed IPv6 loopback spelling a Location actually produces', () => {
    const resolution = resolveBrowserFlow(providers.openrouter, ipv6LoopbackOrigin)

    expectPopup(resolution)
    expect(resolution.redirectUri).toBe('http://[::1]:5173/')
  })

  it('leaves genuine https origins entirely unaffected', () => {
    const resolution = resolveBrowserFlow(providers.openrouter, httpsOrigin)
    expectPopup(resolution)
    expect(resolution.redirectUri).toBe('https://app.example.com/')
  })
})

describe('device resolution', () => {
  it('surfaces devicePrerequisite for openai, which declares one', () => {
    const resolution = resolveBrowserFlow(providers.openai, httpsOrigin)
    expect(resolution).toMatchObject({
      flow: 'device',
      devicePrerequisite: providers.openai.devicePrerequisite,
    })
  })

  it('omits devicePrerequisite for a provider that declares none', () => {
    const resolution = resolveBrowserFlow(providers.xai, httpsOrigin)
    expect(resolution).toMatchObject({ flow: 'device' })
    expect('devicePrerequisite' in resolution).toBe(false)
  })

  it('treats OpenAI’s deviceFlow override as device support, not just deviceAuthorizationUrl', () => {
    // OpenAI's device flow is not RFC 8628, so it is declared only via the
    // deviceFlow hook — checking deviceAuthorizationUrl alone would wrongly
    // answer "no device support" for the one provider where device is the
    // only browser option at all.
    expect(providers.openai.deviceAuthorizationUrl).toBeUndefined()
    expect(providers.openai.deviceFlow).toBeDefined()
    expect(resolveBrowserFlow(providers.openai, httpsOrigin).flow).toBe('device')
  })
})

describe('paste hints', () => {
  const base = {
    label: 'Acme',
    clientId: 'acme-client',
    authorizationUrl: 'https://acme.test/authorize',
    tokenUrl: 'https://acme.test/token',
    scopes: ['openid'],
  }

  const hostedProvider: ProviderConfig = defineProvider({
    ...base,
    id: 'acme-hosted',
    redirect: { mode: 'hosted', hostedUri: 'https://acme.test/code' },
  })

  const loopbackProvider: ProviderConfig = defineProvider({
    ...base,
    id: 'acme-loopback',
    redirect: { mode: 'loopback' },
  })

  it('hints at the provider’s own page for a hostedUri provider', () => {
    const resolution = resolveBrowserFlow(hostedProvider, httpsOrigin)
    expectPaste(resolution)
    expect(resolution.hint.kind).toBe('hosted')
  })

  it('hints at the address bar for a provider with no hostedUri', () => {
    const resolution = resolveBrowserFlow(loopbackProvider, httpsOrigin)
    expectPaste(resolution)
    expect(resolution.hint.kind).toBe('unreachable')
  })

  it('gives the two cases different messages, since the UI has to say different things', () => {
    const hosted = resolveBrowserFlow(hostedProvider, httpsOrigin)
    const loopback = resolveBrowserFlow(loopbackProvider, httpsOrigin)
    expectPaste(hosted)
    expectPaste(loopback)
    expect(hosted.hint.message).not.toBe(loopback.hint.message)
  })
})

describe('a third-party provider declaring none of the new fields', () => {
  const provider: ProviderConfig = defineProvider({
    id: 'acme-plain',
    label: 'Acme',
    clientId: 'acme-client',
    authorizationUrl: 'https://acme.test/authorize',
    tokenUrl: 'https://acme.test/token',
    scopes: ['openid'],
    redirect: { mode: 'custom' },
  })

  it('resolves sensibly rather than throwing', () => {
    expect(() => resolveBrowserFlow(provider, loopbackOrigin)).not.toThrow()
    expect(() => resolveBrowserFlow(provider, httpsOrigin)).not.toThrow()
  })

  it('falls back to paste, with an "address will not load" hint', () => {
    const resolution = resolveBrowserFlow(provider, httpsOrigin)
    expectPaste(resolution)
    expect(resolution.hint.kind).toBe('unreachable')
  })
})
