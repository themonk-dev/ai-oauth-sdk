import { describe, expect, it } from 'vitest'

import { OAuthError } from '../src/errors.js'
import { azureAi, providers } from '../src/providers/index.js'
import { manualReceiver } from '../src/receivers/manual.js'
import type { ProviderConfig } from '../src/types.js'

const start = (provider: ProviderConfig, redirectUri?: string) =>
  manualReceiver({
    prompt: async () => 'code-from-the-user',
    ...(redirectUri ? { redirectUri } : {}),
  }).start({ provider })

describe('manualReceiver redirect URI', () => {
  // Paste mode used to fall back to `redirect.hostedUri` alone, so it worked
  // for Anthropic and threw `configuration_error` for every loopback provider —
  // which is most of them, and exactly what `--paste` is for on a headless box.
  it.each([
    ['openai', 'http://localhost:1455/auth/callback'],
    ['gemini', 'http://localhost:49713/oauth2callback'],
    ['xai', 'http://127.0.0.1:56121/callback'],
    ['openrouter', 'http://localhost:49713/callback'],
  ])('synthesises a loopback URI for %s', async (id, expected) => {
    const started = await start(providers[id as keyof typeof providers] as ProviderConfig)
    expect(started.redirectUri).toBe(expected)
  })

  it('uses the published URI for a hosted provider', async () => {
    const started = await start(providers.claude)
    expect(started.redirectUri).toBe('https://platform.claude.com/oauth/code/callback')
  })

  it.each(['github-copilot', 'qwen'])(
    'refuses %s, which has no redirect at all, and names the alternative',
    async (id) => {
      const provider = providers[id as keyof typeof providers] as ProviderConfig
      await expect(start(provider)).rejects.toThrow(/device-code flow/)
      await expect(start(provider)).rejects.toBeInstanceOf(OAuthError)
    },
  )

  it('always prefers an explicit redirectUri', async () => {
    const started = await start(providers.openai, 'http://localhost:9999/mine')
    expect(started.redirectUri).toBe('http://localhost:9999/mine')
  })

  it('honours a provider that accepts any port by picking a fixed one', async () => {
    // `loopbackPort: 0` means "bind anything" to a real server. Nothing listens
    // in paste mode, so the value only has to survive into the token request —
    // but it must still be a real port, not a literal 0.
    expect(providers.gemini.redirect.loopbackPort).toBe(0)
    const started = await start(providers.gemini)
    expect(started.redirectUri).not.toContain(':0/')
  })

  /*
   * The fallback port used to be 1455 — the port this SDK publishes for
   * `openai` and the one the Codex CLI binds — on the premise that nothing is
   * listening. Something is: the browser still delivers `?code=…&state=…` to
   * whoever holds the port, so a gemini / openrouter / azure-ai / custom paste
   * login handed its authorization code to an unrelated local process. PKCE
   * keeps that code from being redeemable; its confidentiality is the loss.
   *
   * `login openai --paste` still uses 1455 because `openai` *declares* it, and
   * that is a separate matter from this fallback.
   */
  it('falls back to a port no bundled provider declares', async () => {
    const declared = new Set(
      [...Object.values(providers), azureAi({ clientId: 'azure-client', tenant: 'contoso' })]
        .map((provider) => provider.redirect.loopbackPort)
        .filter((port): port is number => typeof port === 'number' && port !== 0),
    )
    expect(declared).toContain(1455)
    expect(declared).toContain(56121)

    const started = await start(providers.gemini)
    const port = Number(new URL(started.redirectUri as string).port)

    expect(declared).not.toContain(port)
    // The IANA dynamic range, which is registered to nobody.
    expect(port).toBeGreaterThanOrEqual(49_152)
    expect(port).toBeLessThanOrEqual(65_535)
  })
})
