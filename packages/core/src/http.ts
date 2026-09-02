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
 * make, and if it will not, honour the abort on our side instead by racing it.
 * The caller's promise still rejects promptly either way — the only thing lost
 * in the fallback is cancelling the in-flight socket, which for a single small
 * token request is a fair trade against not working at all.
 *
 * The probe constructs a `Request`, which ships alongside `fetch` and so
 * validates against the same realm undici will, without making a network call.
 * A runtime missing either constructor has nothing to check and is assumed to
 * take the happy path.
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
      signalAccepted = true

      return signalAccepted
    }

    new RequestCtor('http://localhost/', { signal: new ControllerCtor().signal })
    signalAccepted = true
  } catch {
    signalAccepted = false
  }

  return signalAccepted
}

/**
 * Rejects when `signal` aborts, and never otherwise.
 *
 * Returns a `cancel` alongside the promise because the request normally wins
 * the race and leaves this one pending forever: without releasing the listener,
 * every *completed* request would leave one — and the `reject` closure it
 * captured — on the caller's signal. A device-code poll reuses a single signal
 * for every attempt, so that is one leaked listener per poll, and an
 * `AbortSignal` emits no `MaxListenersExceededWarning` to say so.
 */
function rejectOnAbort(
  signal: AbortSignal,
  message: string,
): { promise: Promise<never>; cancel: () => void } {
  let onAbort: (() => void) | undefined

  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new OAuthError('aborted', message))

      return
    }

    onAbort = () => reject(new OAuthError('aborted', message))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  return {
    promise,
    cancel: () => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
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

  const abort = rejectOnAbort(signal, abortMessage)

  try {
    return await Promise.race([fetchImpl(url, init), abort.promise])
  } finally {
    abort.cancel()
  }
}

/** Test seam — forces the next call to re-detect. */
export function resetSignalSupportCache(): void {
  signalAccepted = undefined
}
