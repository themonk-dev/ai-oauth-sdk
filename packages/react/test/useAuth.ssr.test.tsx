// This file carries no environment pragma, so it runs under vitest.config.ts's
// default `node` environment, which has no `window` global — the same absence
// a server render sees. `react-dom/server` renders without one.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { memoryStorage, providers } from '@ai-oauth-sdk/core'

import { useAuth } from '../src/useAuth.js'

function FlowProbe() {
  const auth = useAuth({
    provider: providers.claude,
    clientId: 'test-client',
    storage: memoryStorage(),
    restoreOnMount: false,
  })

  return <span data-testid="flow">{auth.flow ? JSON.stringify(auth.flow) : 'none'}</span>
}

describe('useAuth flow on the server', () => {
  it('does not throw without a browser window', () => {
    expect(typeof window).toBe('undefined')
    expect(() => renderToStaticMarkup(<FlowProbe />)).not.toThrow()
  })

  it('reports flow as absent rather than guessing', () => {
    const html = renderToStaticMarkup(<FlowProbe />)
    expect(html).toContain('none')
  })
})
