import { describe, expect, it } from 'vitest'

import { defineProvider, providers, type BuiltInProviderId, type ProviderConfig } from '@ai-oauth-sdk/core'

import { resolveBrowserFlow, type BrowserFlowResolution, type BrowserOrigin } from '../src/flow.js'

/** A dev server on an arbitrary port — not any built-in provider's fixed port. */
const loopbackOrigin: BrowserOrigin = { protocol: 'http:', hostname: 'localhost', port: '5173' }

/** A deployed app, the shape every non-loopback consumer actually runs from. */
const httpsOrigin: BrowserOrigin = { protocol: 'https:', hostname: 'app.example.com', port: '' }

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
