// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  defineProvider,
  memoryStorage,
  type AuthStorage,
  type CallbackReceiver,
  type ProviderConfig,
} from '@ai-oauth-sdk/core'

import { AuthProvider, useAuthContext } from '../src/context.js'
import { useAuth } from '../src/useAuth.js'
import {
  startFakeAuthServer,
  type FakeAuthServer,
} from '../../core/test/helpers/fakeAuthServer.js'

let server: FakeAuthServer

const testProvider = (url: string): ProviderConfig =>
  defineProvider({
    id: 'test',
    label: 'Test',
    clientId: 'test-client',
    authorizationUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    scopes: ['openid'],
    redirect: { mode: 'custom' },
  })

/** Drives the fake authorization endpoint the way a browser would. */
const scriptedReceiver = (): CallbackReceiver => ({
  id: 'scripted',
  async start() {
    let result: Promise<{ code: string; state: string }> | undefined

    return {
      redirectUri: 'http://localhost/callback',
      async present(url) {
        result = fetch(url, { redirect: 'manual' }).then((response) => {
          const params = new URL(response.headers.get('location')!).searchParams

          return { code: params.get('code')!, state: params.get('state')! }
        })
      },
      wait: () => result!,
      async close() {},
    }
  },
})

const hangingReceiver = (): CallbackReceiver => ({
  id: 'hanging',
  async start() {
    return {
      redirectUri: 'http://localhost/callback',
      async present() {},
      wait: () => new Promise<never>(() => {}),
      async close() {},
    }
  },
})

function describeStatus(auth: { isLoading: boolean; isAuthenticated: boolean }): string {
  if (auth.isLoading) {
    return 'loading'
  }

  if (auth.isAuthenticated) {
    return 'signed-in'
  }

  return 'signed-out'
}

function SignIn({ storage, receiver }: { storage: AuthStorage; receiver?: CallbackReceiver }) {
  const auth = useAuth({
    provider: testProvider(server.url),
    redirectUri: 'http://localhost/callback',
    storage,
    ...(receiver ? { receiver } : {}),
  })

  return (
    <div>
      <span data-testid="status">
        {describeStatus(auth)}
      </span>
      <span data-testid="token">{auth.tokens?.accessToken ?? ''}</span>
      <span data-testid="error">{auth.error?.message ?? ''}</span>
      <button onClick={() => void auth.login()}>login</button>
      <button onClick={() => void auth.logout()}>logout</button>
      <button onClick={() => auth.cancel()}>cancel</button>
    </div>
  )
}

beforeEach(async () => {
  server = await startFakeAuthServer()
})

afterEach(async () => {
  // Vitest is not configured with `globals`, so testing-library's automatic
  // afterEach cleanup never registers — unmount explicitly or the previous
  // test's DOM leaks into the next one.
  cleanup()
  await server.close()
  vi.restoreAllMocks()
})

describe('useAuth', () => {
  it('starts signed out', async () => {
    render(<SignIn storage={memoryStorage()} receiver={scriptedReceiver()} />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))
  })

  it('signs in and exposes the tokens', async () => {
    render(<SignIn storage={memoryStorage()} receiver={scriptedReceiver()} />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))

    await act(async () => {
      screen.getByText('login').click()
    })

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in'))
    expect(screen.getByTestId('token').textContent).toBe('access-1')
  })

  it('signs out again', async () => {
    render(<SignIn storage={memoryStorage()} receiver={scriptedReceiver()} />)
    await act(async () => {
      screen.getByText('login').click()
    })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in'))

    await act(async () => {
      screen.getByText('logout').click()
    })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))
  })

  it('restores a persisted session on mount', async () => {
    const storage = memoryStorage()
    // First mount signs in.
    const first = render(<SignIn storage={storage} receiver={scriptedReceiver()} />)
    await act(async () => {
      screen.getByText('login').click()
    })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in'))
    first.unmount()

    // A fresh mount over the same storage should already be signed in.
    render(<SignIn storage={storage} receiver={scriptedReceiver()} />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in'))
  })

  it('surfaces an error without throwing during render', async () => {
    const failing = await startFakeAuthServer({ failWith: 'invalid_grant' })

    try {
      function FailingSignIn() {
        const auth = useAuth({
          provider: testProvider(failing.url),
          redirectUri: 'http://localhost/callback',
          storage: memoryStorage(),
          receiver: scriptedReceiver(),
        })

        return (
          <div>
            <span data-testid="status">{auth.isAuthenticated ? 'signed-in' : 'signed-out'}</span>
            <span data-testid="error">{auth.error?.message ?? ''}</span>
            <button onClick={() => void auth.login()}>login</button>
          </div>
        )
      }

      render(<FailingSignIn />)
      await act(async () => {
        screen.getByText('login').click()
      })

      await waitFor(() => expect(screen.getByTestId('error').textContent).toContain('failed'))
      expect(screen.getByTestId('status').textContent).toBe('signed-out')
    } finally {
      await failing.close()
    }
  })

  it('treats cancellation as a non-error', async () => {
    render(<SignIn storage={memoryStorage()} receiver={hangingReceiver()} />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))

    await act(async () => {
      screen.getByText('login').click()
    })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('loading'))

    await act(async () => {
      screen.getByText('cancel').click()
    })

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))
    // Closing a popup is a user action, not something to show as a failure.
    expect(screen.getByTestId('error').textContent).toBe('')
  })

  it('reports a missing receiver rather than throwing', async () => {
    render(<SignIn storage={memoryStorage()} />)
    await act(async () => {
      screen.getByText('login').click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toMatch(/No receiver configured/),
    )
  })

  it('rebuilds the client when the descriptor changes but its id does not', async () => {
    // `azureAi()` is the real case: `id: 'azure-ai'` is fixed while the
    // endpoints are tenant-scoped, so a memo keyed on the id alone handed back
    // the old tenant's client — still pointed at the old tenant, and still
    // serving its cached access token — after a tenant switch. Re-keying only
    // separates the in-memory clients; two of them for one id still read the
    // same `tokens:<id>` record out of a persistent storage, which is what
    // `accountKey` is for.
    function Tenanted({ url }: { url: string }) {
      const auth = useAuth({
        provider: defineProvider({
          id: 'tenanted',
          label: 'Tenanted',
          clientId: 'test-client',
          authorizationUrl: `${url}/authorize`,
          tokenUrl: `${url}/token`,
          scopes: ['openid'],
          redirect: { mode: 'custom' },
        }),
        storage: memoryStorage(),
      })

      return <span data-testid="token-url">{auth.client.provider.tokenUrl}</span>
    }

    const view = render(<Tenanted url="https://tenant-one.test" />)
    await waitFor(() =>
      expect(screen.getByTestId('token-url').textContent).toBe('https://tenant-one.test/token'),
    )

    view.rerender(<Tenanted url="https://tenant-two.test" />)
    await waitFor(() =>
      expect(screen.getByTestId('token-url').textContent).toBe('https://tenant-two.test/token'),
    )
  })

  it('does not warn about state updates after unmount', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(<SignIn storage={memoryStorage()} receiver={hangingReceiver()} />)

    await act(async () => {
      screen.getByText('login').click()
    })
    // Unmount mid-flight: the store must not push state into a dead component.
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('AuthProvider / useAuthContext', () => {
  function Consumer() {
    const auth = useAuthContext()

    return <span data-testid="ctx">{auth.isAuthenticated ? 'yes' : 'no'}</span>
  }

  it('shares one session across the tree', async () => {
    render(
      <AuthProvider
        provider={testProvider(server.url)}
        redirectUri="http://localhost/callback"
        storage={memoryStorage()}
        receiver={scriptedReceiver()}
      >
        <Consumer />
        <Consumer />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getAllByTestId('ctx')).toHaveLength(2))

    for (const node of screen.getAllByTestId('ctx')) {
      expect(node.textContent).toBe('no')
    }
  })

  it('throws a clear error when used outside a provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Consumer />)).toThrowError(/inside an <AuthProvider>/)
    consoleError.mockRestore()
  })
})
