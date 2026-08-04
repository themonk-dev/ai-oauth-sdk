// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { memoryStorage, providers, type CallbackReceiver, type ProviderConfig } from '@ai-oauth-sdk/core'
import type { BrowserOrigin } from '@ai-oauth-sdk/browser'

import { useAuth } from '../src/useAuth.js'

/** A deployed app — the origin every non-loopback consumer actually runs from. */
const httpsOrigin: BrowserOrigin = { protocol: 'https:', hostname: 'app.example.com', port: '' }

/** Never started — these tests only look at the resolved `flow`, not a real login. */
const unusedReceiver: CallbackReceiver = {
  id: 'unused',
  async start() {
    throw new Error('should not be called')
  },
}

function FlowProbe({
  provider,
  origin,
  receiver,
}: {
  provider: ProviderConfig
  origin?: BrowserOrigin
  receiver?: CallbackReceiver
}) {
  const auth = useAuth({
    provider,
    clientId: 'test-client',
    storage: memoryStorage(),
    restoreOnMount: false,
    ...(origin ? { origin } : {}),
    ...(receiver ? { receiver } : {}),
  })

  return <span data-testid="flow">{auth.flow ? JSON.stringify(auth.flow) : 'none'}</span>
}

afterEach(() => {
  cleanup()
})

describe('useAuth flow', () => {
  it('resolves a popup provider', async () => {
    render(<FlowProbe provider={providers.openrouter} origin={httpsOrigin} />)

    await waitFor(() => expect(screen.getByTestId('flow').textContent).not.toBe('none'))
    expect(JSON.parse(screen.getByTestId('flow').textContent!)).toEqual({
      flow: 'popup',
      redirectUri: 'https://app.example.com/',
    })
  })

  it('resolves a device provider, with devicePrerequisite reaching the consumer for openai', async () => {
    render(<FlowProbe provider={providers.openai} origin={httpsOrigin} />)

    await waitFor(() => expect(screen.getByTestId('flow').textContent).not.toBe('none'))
    const flow = JSON.parse(screen.getByTestId('flow').textContent!)
    expect(flow.flow).toBe('device')
    expect(flow.devicePrerequisite).toBe(providers.openai.devicePrerequisite)
    expect(flow.devicePrerequisite).toBeTruthy()
  })

  it('resolves a paste provider', async () => {
    render(<FlowProbe provider={providers.gemini} origin={httpsOrigin} />)

    await waitFor(() => expect(screen.getByTestId('flow').textContent).not.toBe('none'))
    const flow = JSON.parse(screen.getByTestId('flow').textContent!)
    expect(flow.flow).toBe('paste')
    expect(flow.hint.kind).toBe('unreachable')
  })

  it('resolves without a browser window when an explicit origin is supplied', async () => {
    // No jsdom trickery needed: an explicit `origin` never touches `window`,
    // so it is available on the very first render.
    render(<FlowProbe provider={providers.claude} origin={httpsOrigin} />)
    expect(screen.getByTestId('flow').textContent).not.toBe('none')
  })

  it('still resolves flow when the consumer supplies their own receiver', async () => {
    // `resolveBrowserFlow` only looks at the provider and the origin, so a
    // custom receiver does not change what `flow` reports — it describes the
    // automatic choice, not this receiver's behaviour.
    render(<FlowProbe provider={providers.openrouter} origin={httpsOrigin} receiver={unusedReceiver} />)

    await waitFor(() => expect(screen.getByTestId('flow').textContent).not.toBe('none'))
    expect(JSON.parse(screen.getByTestId('flow').textContent!)).toEqual({
      flow: 'popup',
      redirectUri: 'https://app.example.com/',
    })
  })

  it('falls back to window.location when no origin is supplied', async () => {
    // jsdom defaults to http://localhost/ (see vitest.config.ts), a loopback
    // origin where openrouter's loopbackPort: 0 always resolves to popup.
    render(<FlowProbe provider={providers.openrouter} />)

    await waitFor(() => expect(screen.getByTestId('flow').textContent).not.toBe('none'))
    expect(JSON.parse(screen.getByTestId('flow').textContent!)).toEqual({
      flow: 'popup',
      redirectUri: 'http://localhost/',
    })
  })
})
