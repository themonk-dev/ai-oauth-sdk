// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineProvider, memoryStorage, type AuthStorage, type ProviderConfig } from '@ai-oauth-sdk/core'

import { useAuth } from '../src/useAuth.js'

afterEach(cleanup)

const provider: ProviderConfig = defineProvider({
  id: 'test',
  label: 'Test',
  clientId: 'test-client',
  authorizationUrl: 'https://example.invalid/authorize',
  tokenUrl: 'https://example.invalid/token',
  scopes: ['openid'],
  redirect: { mode: 'custom' },
})

/** A store already holding a session, the way a signed-in user's would. */
const storageHolding = async (accessToken: string): Promise<AuthStorage> => {
  const storage = memoryStorage()

  await storage.set(
    'tokens:test',
    JSON.stringify({
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      tokenType: 'Bearer',
      provider: 'test',
      raw: {},
    }),
  )

  return storage
}

function Session({ storage, storageKey }: { storage: AuthStorage; storageKey?: string }) {
  const auth = useAuth({
    provider,
    storage,
    ...(storageKey === undefined ? {} : { storageKey }),
  })

  return <span data-testid="token">{auth.tokens?.accessToken ?? 'none'}</span>
}

const tokenText = () => screen.getByTestId('token').textContent

describe('storage identity', () => {
  /**
   * The hazard this pins: `storage` is captured when the client is built and
   * held in a `readonly` field, so an app that scopes storage per signed-in
   * user and swaps it does not get a new client. Without a `storageKey` the
   * memo key never moves and the previous user's tokens go on being served —
   * access *and* refresh — which is cross-user credential disclosure rather
   * than a stale-config annoyance.
   */
  it('re-keys the client when storageKey changes, so the new store is actually read', async () => {
    const alice = await storageHolding('alice')
    const bob = await storageHolding('bob')

    const view = render(<Session storage={alice} storageKey="alice" />)

    await waitFor(() => expect(tokenText()).toBe('alice'))

    view.rerender(<Session storage={bob} storageKey="bob" />)

    await waitFor(() => expect(tokenText()).toBe('bob'))
  })

  it('warns in dev when storage is swapped while a session is held and no storageKey is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const alice = await storageHolding('alice')
      const bob = await storageHolding('bob')
      const carol = await storageHolding('carol')

      const view = render(<Session storage={alice} />)

      await waitFor(() => expect(tokenText()).toBe('alice'))

      view.rerender(<Session storage={bob} />)

      await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
      expect(String(warn.mock.calls[0]?.[0])).toContain('`storage` changed while a session was held')

      // Latched: the inline-adapter idiom would otherwise warn every render.
      view.rerender(<Session storage={carol} />)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  /**
   * The swap must not paint the old store's tokens under the new client, even
   * for the one render between the memo returning a new store and its
   * subscription emitting. That render commits, so a `waitFor` on the settled
   * value cannot see it — the sequence has to be recorded as it happens.
   */
  it('never commits a render showing the previous store tokens under the new client', async () => {
    const alice = await storageHolding('alice')
    const bob = await storageHolding('bob')
    const seen: string[] = []

    function Recording({ storage, storageKey }: { storage: AuthStorage; storageKey: string }) {
      const auth = useAuth({ provider, storage, storageKey })

      // Recorded after commit, not during render: a render React discards
      // never reaches the screen, and it is the committed ones that matter.
      useEffect(() => {
        seen.push(`${storageKey}:${auth.tokens?.accessToken ?? 'none'}`)
      })

      return <span data-testid="token">{auth.tokens?.accessToken ?? 'none'}</span>
    }

    const view = render(<Recording storage={alice} storageKey="alice" />)

    await waitFor(() => expect(tokenText()).toBe('alice'))

    view.rerender(<Recording storage={bob} storageKey="bob" />)

    await waitFor(() => expect(tokenText()).toBe('bob'))

    expect(seen.filter((entry) => entry === 'bob:alice')).toEqual([])
  })

  it('does not warn when the client was correctly re-keyed through accountKey', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const alice = await storageHolding('alice')
      const bob = await storageHolding('bob')

      function Scoped({ storage, accountKey }: { storage: AuthStorage; accountKey: string }) {
        const auth = useAuth({ provider, storage, accountKey })

        return <span data-testid="token">{auth.tokens?.accessToken ?? 'none'}</span>
      }

      const view = render(<Scoped storage={alice} accountKey="alice" />)

      await waitFor(() => expect(tokenText()).toBe('none'))

      view.rerender(<Scoped storage={bob} accountKey="bob" />)
      await waitFor(() => expect(tokenText()).toBe('none'))

      // `accountKey` is part of the identity, so the client already moved.
      // Warning here would be a warning at correct code.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps one client while only adapter identity churns, so an inline store cannot thrash it', async () => {
    const clients: unknown[] = []
    const alice = await storageHolding('alice')

    function Churn({ label }: { label: string }) {
      // A fresh options object every render, adapters included by identity.
      const auth = useAuth({ provider, storage: alice, extraAuthParams: { prompt: label } })
      clients.push(auth.client)

      return <span data-testid="token">{auth.tokens?.accessToken ?? 'none'}</span>
    }

    const view = render(<Churn label="consent" />)

    await waitFor(() => expect(tokenText()).toBe('alice'))

    view.rerender(<Churn label="consent" />)
    view.rerender(<Churn label="consent" />)

    // `extraAuthParams` is compared by value, so an inline object does not
    // rebuild the client and cannot cancel an in-flight login.
    expect(new Set(clients).size).toBe(1)
  })
})
