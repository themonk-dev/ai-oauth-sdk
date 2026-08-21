// @vitest-environment jsdom
import { StrictMode, useEffect, useRef } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { defineProvider, memoryStorage, type AuthStorage, type ProviderConfig } from '@ai-oauth-sdk/core'

import { useAuth } from '../src/useAuth.js'

/**
 * Two providers that never need a network: these tests only exercise
 * restore-from-storage, which reads the credential store and nothing else.
 */
const offlineProvider = (id: string): ProviderConfig =>
  defineProvider({
    id,
    label: id,
    clientId: `${id}-client`,
    authorizationUrl: `https://${id}.example.com/authorize`,
    tokenUrl: `https://${id}.example.com/token`,
    scopes: ['openid'],
    redirect: { mode: 'custom' },
  })

const alpha = offlineProvider('alpha')
const beta = offlineProvider('beta')

const storedToken = (provider: string, accessToken: string): string =>
  JSON.stringify({ accessToken, tokenType: 'Bearer', provider })

/**
 * Records what the browser actually painted. The effect carries no dependency
 * array, so it runs after every commit, and it reads the mounted node rather
 * than the render's own variables — a render React threw away never shows up.
 */
function useCommits(commits: string[]) {
  const node = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    commits.push(node.current?.textContent ?? '')
  })

  return node
}

/** Renders the provider's identity next to the token the hook hands back. */
function ProviderProbe({
  provider,
  storage,
  commits,
}: {
  provider: ProviderConfig
  storage: AuthStorage
  commits: string[]
}) {
  const auth = useAuth({ provider, redirectUri: 'http://localhost/callback', storage })
  const node = useCommits(commits)

  return <span ref={node} data-testid="label">{`${auth.client.provider.id}|${auth.tokens?.accessToken ?? '-'}`}</span>
}

/** The multi-user shape: one provider, the account swapped underneath it. */
function AccountProbe({
  accountKey,
  storage,
  commits,
}: {
  accountKey: string
  storage: AuthStorage
  commits: string[]
}) {
  const auth = useAuth({ provider: alpha, redirectUri: 'http://localhost/callback', storage, accountKey })
  const node = useCommits(commits)

  return <span ref={node} data-testid="label">{`${accountKey}|${auth.tokens?.accessToken ?? '-'}`}</span>
}

afterEach(() => {
  cleanup()
})

describe('useAuth store identity', () => {
  it('never paints the previous provider tokens under the new provider', async () => {
    const storage = memoryStorage(
      new Map([
        ['tokens:alpha', storedToken('alpha', 'ALPHA-SECRET')],
        ['tokens:beta', storedToken('beta', 'BETA-SECRET')],
      ]),
    )
    const commits: string[] = []

    const view = render(<ProviderProbe provider={alpha} storage={storage} commits={commits} />)
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('alpha|ALPHA-SECRET'))

    view.rerender(<ProviderProbe provider={beta} storage={storage} commits={commits} />)
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('beta|BETA-SECRET'))

    // The rebuilt store starts with no tokens, so every committed frame that
    // says "beta" must show either nothing or beta's own token. A frame
    // labelling alpha's bearer token as beta's is the defect.
    expect(commits).not.toContain('beta|ALPHA-SECRET')
    expect(commits).toEqual([
      'alpha|-',
      'alpha|-',
      'alpha|ALPHA-SECRET',
      'beta|-',
      'beta|-',
      'beta|BETA-SECRET',
    ])
  })

  it('never paints the previous account tokens under the new account', async () => {
    const storage = memoryStorage(
      new Map([
        ['tokens:alpha:alice', storedToken('alpha', 'ALICE-SECRET')],
        ['tokens:alpha:bob', storedToken('alpha', 'BOB-SECRET')],
      ]),
    )
    const commits: string[] = []

    const view = render(<AccountProbe accountKey="alice" storage={storage} commits={commits} />)
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('alice|ALICE-SECRET'))

    view.rerender(<AccountProbe accountKey="bob" storage={storage} commits={commits} />)
    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('bob|BOB-SECRET'))

    expect(commits).not.toContain('bob|ALICE-SECRET')
  })

  it('still restores after the remount StrictMode simulates', async () => {
    // StrictMode mounts, tears the effect down, and mounts again over the same
    // memoised store. The teardown must only cancel an in-flight login —
    // destroying the store here would silence it permanently and leave the
    // component signed out for good.
    const storage = memoryStorage(new Map([['tokens:alpha', storedToken('alpha', 'ALPHA-SECRET')]]))

    render(
      <StrictMode>
        <ProviderProbe provider={alpha} storage={storage} commits={[]} />
      </StrictMode>,
    )

    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('alpha|ALPHA-SECRET'))
  })
})
