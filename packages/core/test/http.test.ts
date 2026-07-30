import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchWithSignal, resetSignalSupportCache } from '../src/http.js'
import type { FetchLike } from '../src/types.js'

afterEach(() => {
  resetSignalSupportCache()
  vi.unstubAllGlobals()
})

const okResponse = () => new Response('{}', { status: 200 })

describe('fetchWithSignal', () => {
  it('passes no signal through when the caller gave none', async () => {
    const seen: Array<RequestInit | undefined> = []
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init)
      return okResponse()
    }

    await fetchWithSignal(fetchImpl, 'http://x.test/', { method: 'POST' }, undefined)
    expect(seen[0]).toEqual({ method: 'POST' })
    expect(seen[0]).not.toHaveProperty('signal')
  })

  it('forwards the signal when the runtime accepts it', async () => {
    const seen: Array<RequestInit | undefined> = []
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init)
      return okResponse()
    }
    const controller = new AbortController()

    await fetchWithSignal(fetchImpl, 'http://x.test/', {}, controller.signal)
    // Real cancellation, which is what we want wherever it is available.
    expect(seen[0]?.signal).toBe(controller.signal)
  })

  it('honours the abort even when fetch refuses the signal', async () => {
    // Reproduces the cross-realm case: undici on Node 24+ throws
    // "Expected signal to be an instance of AbortSignal" for a jsdom-created
    // one, so the library must not hand it over.
    class ForeignRequest {
      constructor(_url: string, init?: { signal?: unknown }) {
        if (init?.signal) {
          throw new TypeError('Expected signal to be an instance of AbortSignal')
        }
      }
    }
    vi.stubGlobal('Request', ForeignRequest)

    const fetchImpl: FetchLike = async (_url, init) => {
      // If the signal leaked through, the real undici would have thrown already.
      expect(init).not.toHaveProperty('signal')
      return new Promise<Response>(() => {}) // never settles
    }

    const controller = new AbortController()
    const pending = fetchWithSignal(fetchImpl, 'http://x.test/', {}, controller.signal, 'nope')
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'aborted', message: 'nope' })
  })

  it('still resolves normally in the fallback path', async () => {
    class ForeignRequest {
      constructor(_url: string, init?: { signal?: unknown }) {
        if (init?.signal) {
          throw new TypeError('foreign signal')
        }
      }
    }
    vi.stubGlobal('Request', ForeignRequest)

    const fetchImpl: FetchLike = async () => new Response('hello', { status: 200 })
    const controller = new AbortController()

    const response = await fetchWithSignal(fetchImpl, 'http://x.test/', {}, controller.signal)
    expect(await response.text()).toBe('hello')
  })

  it('rejects immediately for an already-aborted signal', async () => {
    class ForeignRequest {
      constructor(_url: string, init?: { signal?: unknown }) {
        if (init?.signal) {
          throw new TypeError('foreign signal')
        }
      }
    }
    vi.stubGlobal('Request', ForeignRequest)

    const fetchImpl: FetchLike = async () => new Promise<Response>(() => {})
    const controller = new AbortController()
    controller.abort()

    await expect(
      fetchWithSignal(fetchImpl, 'http://x.test/', {}, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' })
  })

  it('detects support once, not per request', async () => {
    let constructed = 0
    class CountingRequest {
      constructor(_url: string, _init?: unknown) {
        constructed++
      }
    }
    vi.stubGlobal('Request', CountingRequest)

    const fetchImpl: FetchLike = async () => okResponse()
    const controller = new AbortController()
    for (let i = 0; i < 5; i++) {
      await fetchWithSignal(fetchImpl, 'http://x.test/', {}, controller.signal)
    }
    // A probe per token request would be wasteful; one is enough.
    expect(constructed).toBe(1)
  })

  it('assumes the happy path when there is no Request to probe with', async () => {
    // Some minimal runtimes expose fetch without Request.
    vi.stubGlobal('Request', undefined)

    const seen: Array<RequestInit | undefined> = []
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init)
      return okResponse()
    }
    const controller = new AbortController()

    await fetchWithSignal(fetchImpl, 'http://x.test/', {}, controller.signal)
    expect(seen[0]?.signal).toBe(controller.signal)
  })
})
