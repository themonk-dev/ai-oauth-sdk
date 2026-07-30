// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineProvider, memoryStorage, type CallbackReceiver } from '@ai-oauth-sdk/core'
import { useAuth } from '../src/useAuth.js'
import { startFakeAuthServer, type FakeAuthServer } from '../../core/test/helpers/fakeAuthServer.js'

let server: FakeAuthServer
beforeEach(async () => { server = await startFakeAuthServer() })
afterEach(async () => { cleanup(); await server.close(); vi.restoreAllMocks() })

const scripted = (): CallbackReceiver => ({
  id: 'scripted',
  async start() {
    let result: Promise<{ code: string; state: string }> | undefined
    return {
      redirectUri: 'http://localhost/callback',
      async present(url) {
        result = fetch(url, { redirect: 'manual' }).then((r) => {
          const p = new URL(r.headers.get('location')!).searchParams
          return { code: p.get('code')!, state: p.get('state')! }
        })
      },
      wait: () => result!,
      async close() {},
    }
  },
})

it('diagnose', async () => {
  function C() {
    const a = useAuth({
      provider: defineProvider({
        id: 'test', label: 'T', clientId: 'c',
        authorizationUrl: `${server.url}/authorize`, tokenUrl: `${server.url}/token`,
        scopes: ['openid'], redirect: { mode: 'custom' },
      }),
      redirectUri: 'http://localhost/callback',
      storage: memoryStorage(),
      receiver: scripted(),
    })
    return <div>
      <span data-testid="s">{a.isLoading ? 'loading' : a.isAuthenticated ? 'in' : 'out'}</span>
      <span data-testid="e">{a.error?.message ?? ''}</span>
      <button onClick={() => void a.login()}>go</button>
    </div>
  }
  render(<C />)
  await act(async () => { screen.getByText('go').click() })
  await new Promise((r) => setTimeout(r, 800))
  console.log('STATUS:', screen.getByTestId('s').textContent)
  console.log('ERROR :', JSON.stringify(screen.getByTestId('e').textContent))
  console.log('server token requests:', server.requests.length, JSON.stringify(server.requests[0] ?? null))
  expect(true).toBe(true)
})
