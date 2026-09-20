import type { FetchLike } from './types.js'
import { OAuthError, type OAuthErrorCode } from './errors.js'

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

  return Promise.race([fetchImpl(url, init), rejectOnAbort(signal, abortMessage)])
}

/** Test seam — forces the next call to re-detect. */
export function resetSignalSupportCache(): void {
  signalAccepted = undefined
}

/**
 * True for a response that is itself a redirect rather than an answer.
 *
 * Two shapes, because `redirect: 'manual'` reports the same thing differently
 * depending on the runtime: undici hands back the 3xx itself, while browsers
 * and Workers hand back a filtered `opaqueredirect` whose status reads 0 and
 * whose headers are stripped. Both mean "the server told us to go elsewhere".
 */
function isRedirectResponse(response: Response): boolean {
  return (
    response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
  )
}

/**
 * POSTs a request that carries credentials, and refuses to be redirected.
 *
 * `fetch` defaults to `redirect: 'follow'`, and a 307 or 308 preserves the
 * method *and the body* when it is followed. So a token endpoint answering
 * `Location: http://attacker.example/…` would have the runtime replay our POST
 * there — and that body is the refresh token, the PKCE verifier and the client
 * secret, in cleartext if the hop lands on `http`. The hijacker's reply then
 * comes back as the token response and is parsed as one, so the same hop also
 * chooses the access token the caller goes on to use. `providers/index.ts`
 * already refuses a redirected *discovery* document for exactly this reason;
 * the credential-bearing POST beside it had no equivalent.
 *
 * `redirect: 'manual'` plus an explicit check, rather than `redirect: 'error'`:
 * `'error'` rejects with a bare `TypeError: fetch failed` naming neither the
 * provider nor the reason, which is indistinguishable from the network being
 * down, while `'manual'` yields a response every runtime here can describe.
 *
 * Deliberately not folded into {@link fetchWithSignal}. `createAuthenticatedFetch`
 * shares that function for the caller's own API requests, where a redirect is
 * ordinary traffic and following one is the correct behaviour — the rule here
 * is about credentials in a request body, not about requests in general.
 *
 * Known gap: React Native's `fetch` is XHR-backed and ignores `redirect`
 * entirely, so it keeps following and never produces a response this can catch.
 * Nothing breaks there; nothing is enforced there either.
 */
export async function postWithoutRedirects(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  abortMessage: string,
  onRedirect: { code: OAuthErrorCode; describe: string },
): Promise<Response> {
  const response = await fetchWithSignal(
    fetchImpl,
    url,
    { ...init, redirect: 'manual' },
    signal,
    abortMessage,
  )

  if (!isRedirectResponse(response)) {
    return response
  }

  // An `opaqueredirect` reports status 0 and no headers, so there is nothing
  // to quote there beyond the fact that it happened.
  const status = response.status || undefined

  throw new OAuthError(
    onRedirect.code,
    `${onRedirect.describe} was answered with a redirect` +
      `${status ? ` (HTTP ${status})` : ''}, which is refused. Following it would replay this ` +
      'request, and the credentials in its body, to whatever host the Location header names.',
    status !== undefined ? { status } : {},
  )
}
