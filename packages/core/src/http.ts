import type { FetchLike } from './types.js'
import { OAuthError } from './errors.js'

/**
 * `fetch` with an `AbortSignal` that might come from a different realm.
 *
 * `AbortController` and `fetch` do not always come from the same place. Under
 * jsdom the controller is jsdom's while `fetch` is Node's undici; the same split
 * appears in Electron renderers and some bundler sandboxes. Node 24 tightened
 * undici's validation, so passing a foreign signal now throws
 * `RequestInit: Expected signal (...) to be an instance of AbortSignal` before
 * the request is even attempted.
 *
 * So: detect once whether this runtime's `fetch` will accept a signal we can
 * make, and if it will not, honour the abort on our side instead. The caller's
 * promise still rejects promptly either way — the only thing lost in the
 * fallback is cancelling the in-flight socket, which for a single small token
 * request is a fair trade against not working at all.
 */
let signalAccepted: boolean | undefined

function fetchAcceptsOurSignal(): boolean {
  if (signalAccepted !== undefined) {
    return signalAccepted
  }
  try {
    const RequestCtor = (globalThis as { Request?: typeof Request }).Request
    const ControllerCtor = (globalThis as { AbortController?: typeof AbortController }).AbortController
    if (!RequestCtor || !ControllerCtor) {
      signalAccepted = true // nothing to check; assume the happy path
      return signalAccepted
    }
    // `Request` ships alongside `fetch`, so it validates against the same realm
    // undici will — without making a network call.
    new RequestCtor('http://localhost/', { signal: new ControllerCtor().signal })
    signalAccepted = true
  } catch {
    signalAccepted = false
  }
  return signalAccepted
}

/** Rejects when `signal` aborts, and never otherwise. */
function rejectOnAbort(signal: AbortSignal, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new OAuthError('aborted', message))
      return
    }
    signal.addEventListener('abort', () => reject(new OAuthError('aborted', message)), {
      once: true,
    })
  })
}

export async function fetchWithSignal(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  abortMessage = 'Request was aborted.',
): Promise<Response> {
  if (!signal) {
    return fetchImpl(url, init)
  }

  if (fetchAcceptsOurSignal()) {
    return fetchImpl(url, { ...init, signal })
  }

  // Cross-realm signal: race instead of handing it to fetch.
  return Promise.race([fetchImpl(url, init), rejectOnAbort(signal, abortMessage)])
}

/** Test seam — forces the next call to re-detect. */
export function resetSignalSupportCache(): void {
  signalAccepted = undefined
}
