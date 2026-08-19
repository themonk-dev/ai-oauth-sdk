import { describe, expect, it, vi } from 'vitest'

import { defineProvider, type ProviderConfig } from '@ai-oauth-sdk/core'

import { authSessionReceiver, deepLinkReceiver } from '../src/receivers.js'
import { asyncStorageAdapter, secureStoreAdapter } from '../src/storage.js'
import type { LinkingLike, WebBrowserLike } from '../src/deps.js'

const provider: ProviderConfig = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'test-client',
  authorizationUrl: 'https://provider.test/authorize',
  tokenUrl: 'https://provider.test/token',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
})

const REDIRECT = 'myapp://auth/callback'

/** Stands in for `Linking` from react-native. */
function fakeLinking(options: { initialUrl?: string } = {}) {
  const handlers: Array<(event: { url: string }) => void> = []
  const opened: string[] = []
  let removed = false

  const linking: LinkingLike = {
    async openURL(url) {
      opened.push(url)
    },
    async getInitialURL() {
      return options.initialUrl ?? null
    },
    addEventListener(_type, handler) {
      handlers.push(handler)

      return {
        remove() {
          removed = true
        },
      }
    },
  }

  return {
    linking,
    opened,
    emit: (url: string) => handlers.forEach((handler) => handler({ url })),
    get removed() {
      return removed
    },
  }
}

/**
 * What the login did, or `'ignored'` when the receiver never settled it.
 *
 * A dropped deep link leaves `wait()` pending, which is the whole point — so
 * the assertion has to be "still pending after a beat" rather than an outcome.
 */
function outcomeOf(waiting: Promise<unknown>): Promise<string> {
  return Promise.race([
    waiting.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('ignored'), 50)),
  ])
}

describe('deepLinkReceiver', () => {
  it('opens the URL and resolves on the matching deep link', async () => {
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?x=1')
    expect(fake.opened).toEqual(['https://provider.test/authorize?x=1'])

    const waiting = started.wait()
    fake.emit(`${REDIRECT}?code=abc&state=xyz`)
    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'xyz' })

    await started.close()
  })

  it('ignores deep links meant for other parts of the app', async () => {
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })
    const waiting = started.wait()

    fake.emit('myapp://some/other/screen?code=nope')

    const outcome = await Promise.race([
      waiting.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('ignored'), 50)),
    ])
    expect(outcome).toBe('ignored')

    await started.close()
  })

  it('ignores a deep link whose path merely starts with the redirect URI', async () => {
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?state=xyz')
    const waiting = started.wait()

    // The `state` matches, so only the path comparison can turn this away.
    fake.emit(`${REDIRECT}XYZ?code=abc&state=xyz`)
    expect(await outcomeOf(waiting)).toBe('ignored')

    await started.close()
  })

  it('takes an initial URL that belongs to the attempt it presented', async () => {
    // `getInitialURL()` is the OS's other delivery path for the redirect. It
    // resumes nothing across a cold start — a relaunched app mints a new
    // `state` — but the URL is still the callback when the presented `state`
    // says so.
    const fake = fakeLinking({ initialUrl: `${REDIRECT}?code=cold&state=start` })
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?state=start')
    await expect(started.wait()).resolves.toEqual({ code: 'cold', state: 'start' })
    await started.close()
  })

  it('ignores an initial URL left over from an earlier attempt', async () => {
    // `getInitialURL()` does not drain: it answers with the launch URL for the
    // life of the process, so every login after the first sees it again.
    const fake = fakeLinking({ initialUrl: `${REDIRECT}?code=stale&state=previous` })
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?state=current')
    expect(await outcomeOf(started.wait())).toBe('ignored')

    await started.close()
  })

  it('surfaces a denial that echoes the presented state', async () => {
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?state=xyz')
    const waiting = started.wait()

    fake.emit(`${REDIRECT}?error=access_denied&state=xyz`)
    await expect(waiting).rejects.toMatchObject({ code: 'authorization_denied' })

    await started.close()
  })

  it('ignores a denial that carries no state', async () => {
    // Any app on the device can send this one, so it must not be able to fail
    // a login that is genuinely in progress.
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?state=xyz')
    const waiting = started.wait()

    fake.emit(`${REDIRECT}?error=access_denied`)
    expect(await outcomeOf(waiting)).toBe('ignored')

    await started.close()
  })

  it('still takes a callback from a provider that declares it echoes no state', async () => {
    // `buildAuthorizationUrl` puts a `state` on every URL it builds, so unless
    // a provider strips it the way OpenRouter does, one is presented to a
    // provider that has already said it will not send it back. Holding the
    // callback to a comparison the provider cannot satisfy would reject the
    // only callback it can produce, and hang the login until its timeout.
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider: defineProvider({ ...provider, echoesState: false }),
    })

    await started.present('https://provider.test/authorize?state=presented')
    const waiting = started.wait()

    fake.emit(`${REDIRECT}?code=unechoed`)
    await expect(waiting).resolves.toMatchObject({ code: 'unechoed' })

    await started.close()
  })

  it('ignores a callback whose state disagrees', async () => {
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })

    await started.present('https://provider.test/authorize?state=xyz')
    const waiting = started.wait()

    fake.emit(`${REDIRECT}?code=forged&state=someone-elses`)
    expect(await outcomeOf(waiting)).toBe('ignored')

    await started.close()
  })

  it('removes its listener on close', async () => {
    const fake = fakeLinking()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
    })
    await started.close()
    expect(fake.removed).toBe(true)
  })

  it('aborts on signal', async () => {
    const fake = fakeLinking()
    const controller = new AbortController()
    const started = await deepLinkReceiver({ linking: fake.linking, redirectUri: REDIRECT }).start({
      provider,
      signal: controller.signal,
    })
    const waiting = started.wait()

    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
    await started.close()
  })
})

describe('authSessionReceiver', () => {
  const fakeWebBrowser = (result: { type: string; url?: string }): WebBrowserLike & {
    calls: string[][]
  } => {
    const calls: string[][] = []

    return {
      calls,
      async openAuthSessionAsync(url, redirectUrl) {
        calls.push([url, redirectUrl])

        return result
      },
      dismissAuthSession: vi.fn(),
    }
  }

  it('resolves from the session result', async () => {
    const webBrowser = fakeWebBrowser({
      type: 'success',
      url: `${REDIRECT}?code=abc&state=xyz`,
    })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({ provider })

    await started.present('https://provider.test/authorize?x=1')
    expect(webBrowser.calls[0]).toEqual(['https://provider.test/authorize?x=1', REDIRECT])
    await expect(started.wait()).resolves.toEqual({ code: 'abc', state: 'xyz' })

    await started.close()
  })

  it('treats a dismissed sheet as an abort, not an error', async () => {
    const webBrowser = fakeWebBrowser({ type: 'dismiss' })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({ provider })

    await started.present('https://provider.test/authorize')
    await expect(started.wait()).rejects.toMatchObject({ code: 'aborted' })

    await started.close()
  })

  it('surfaces a denial that echoes the presented state', async () => {
    const webBrowser = fakeWebBrowser({
      type: 'success',
      url: `${REDIRECT}?error=access_denied&state=xyz`,
    })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({ provider })

    await started.present('https://provider.test/authorize?state=xyz')
    await expect(started.wait()).rejects.toMatchObject({ code: 'authorization_denied' })

    await started.close()
  })

  it('refuses a session result that does not belong to the attempt it presented', async () => {
    // No Android version has the native auth session, so `openAuthSessionAsync`
    // resolves from the first `Linking` event whose URL starts with the redirect
    // URI — which any app on the device can fire. Without a `state` comparison
    // an unsolicited denial fails a live sign-in as the provider's own.
    const webBrowser = fakeWebBrowser({ type: 'success', url: `${REDIRECT}?error=access_denied` })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({ provider })

    await started.present('https://provider.test/authorize?state=xyz')
    await expect(started.wait()).rejects.toMatchObject({ code: 'state_mismatch' })

    await started.close()
  })

  it('refuses a session result whose state disagrees', async () => {
    const webBrowser = fakeWebBrowser({
      type: 'success',
      url: `${REDIRECT}?error=access_denied&state=nope`,
    })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({ provider })

    await started.present('https://provider.test/authorize?state=xyz')
    await expect(started.wait()).rejects.toMatchObject({ code: 'state_mismatch' })

    await started.close()
  })

  it('still takes a result from a provider that declares it echoes no state', async () => {
    // Same exemption the deep-link receiver draws: a provider that has said its
    // callback brings no `state` back can only send the result this refuses.
    const webBrowser = fakeWebBrowser({ type: 'success', url: `${REDIRECT}?code=unechoed` })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({
      provider: defineProvider({ ...provider, echoesState: false }),
    })

    await started.present('https://provider.test/authorize?state=presented')
    await expect(started.wait()).resolves.toMatchObject({ code: 'unechoed' })

    await started.close()
  })

  it('requires present() before wait()', async () => {
    const webBrowser = fakeWebBrowser({ type: 'success', url: `${REDIRECT}?code=a` })
    const started = await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({ provider })

    await expect(started.wait()).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('dismisses the sheet on abort', async () => {
    const webBrowser = fakeWebBrowser({ type: 'success', url: `${REDIRECT}?code=a` })
    const controller = new AbortController()
    await authSessionReceiver({ webBrowser, redirectUri: REDIRECT }).start({
      provider,
      signal: controller.signal,
    })

    controller.abort()
    expect(webBrowser.dismissAuthSession).toHaveBeenCalled()
  })
})

describe('storage adapters', () => {
  it('wraps AsyncStorage', async () => {
    const map = new Map<string, string>()
    const storage = asyncStorageAdapter({
      async getItem(key) {
        return map.get(key) ?? null
      },
      async setItem(key, value) {
        map.set(key, value)
      },
      async removeItem(key) {
        map.delete(key)
      },
    })

    await storage.set('tokens:openai', 'v')
    expect(await storage.get('tokens:openai')).toBe('v')
    await storage.delete('tokens:openai')
    expect(await storage.get('tokens:openai')).toBeNull()
  })

  it('encodes keys for SecureStore', async () => {
    const seen: string[] = []
    const storage = secureStoreAdapter({
      async getItemAsync(key) {
        seen.push(key)

        return null
      },
      async setItemAsync(key) {
        seen.push(key)
      },
      async deleteItemAsync(key) {
        seen.push(key)
      },
    })

    await storage.set('tokens:openai:work', 'v')
    await storage.get('tokens:openai:work')
    await storage.delete('tokens:openai:work')

    // SecureStore rejects ':' at runtime, so the colons must be encoded — and
    // reversibly, so two keys differing only in disallowed characters stay
    // distinct. See storage.test.ts for the collision cases.
    for (const key of seen) {
      expect(key).toBe('tokens_003aopenai_003awork')
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  it('forwards SecureStore options', async () => {
    const received: Array<Record<string, unknown> | undefined> = []
    const storage = secureStoreAdapter(
      {
        async getItemAsync(_key, options) {
          received.push(options)

          return null
        },
        async setItemAsync(_key, _value, options) {
          received.push(options)
        },
        async deleteItemAsync(_key, options) {
          received.push(options)
        },
      },
      { options: { keychainAccessible: 'WHEN_UNLOCKED' } },
    )

    await storage.set('k', 'v')
    expect(received[0]).toEqual({ keychainAccessible: 'WHEN_UNLOCKED' })
  })
})
