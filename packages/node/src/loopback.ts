import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  OAuthError,
  buildLoopbackRedirectUri,
  isOAuthError,
  readCallback,
  timingSafeEqual,
  type CallbackReceiver,
  type CallbackResult,
  type ReceiverContext,
} from '@ai-oauth-sdk/core'

import { openBrowser } from './browser.js'

export interface LoopbackReceiverOptions {
  /**
   * Port to bind. Defaults to the provider's declared port; `0` picks a free
   * one. Providers that register a *specific* port (OpenAI's 1455) must use it.
   */
  port?: number
  /** Path to listen on. Defaults to the provider's declared path. */
  path?: string
  /**
   * Interface to bind. Defaults to 127.0.0.1 — never bind 0.0.0.0 for this.
   *
   * An IPv6 literal goes in unbracketed (`'::1'`): Node resolves `'[::1]'` as a
   * hostname and fails, so that is the only form which ever binds the IPv6
   * loopback interface.
   */
  host?: string
  /** Host used when building the redirect URI. Defaults to the provider's. */
  redirectHost?: string
  /** HTML shown after a successful callback. */
  successHtml?: string
  /** Builds the HTML shown after a failed callback. */
  failureHtml?: (error: string) => string
  /** Open the browser automatically. Default true. */
  openBrowser?: boolean
  /** Called with the authorization URL, e.g. to print it as a fallback. */
  onAuthorizationUrl?: (url: string) => void
}

function page(title: string, message: string, accent: string, glyph: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background:#fbfbfd; color:#18181b; }
  @media (prefers-color-scheme: dark) { body { background:#0b0b0f; color:#e7e7ea; } }
  .card { text-align:center; padding:2.5rem 3rem; max-width:32rem; }
  .dot { width:2.75rem; height:2.75rem; border-radius:999px; margin:0 auto 1.25rem;
         display:grid; place-items:center; background:${accent}1a; color:${accent}; font-size:1.4rem; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; font-weight:600; }
  p { margin:0; opacity:.7; }
</style>
</head>
<body>
  <div class="card">
    <div class="dot">${glyph}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

const DEFAULT_SUCCESS_HTML = page(
  'Signed in',
  'You can close this tab and return to your terminal.',
  '#16a34a',
  '&#10003;',
)

const defaultFailureHtml = (error: string) =>
  page('Sign-in failed', escapeHtml(error), '#dc2626', '&#33;')

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Headers for the callback responses.
 *
 * The URL that lands here carries the authorization code in its query string.
 * `no-store` keeps it out of any intermediary cache, and `no-referrer` stops it
 * leaking through a Referer header if the page ever gains an outbound link.
 * There is nothing sensitive in the page body itself.
 */
const securityHeaders: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * The `state` in an authorization URL, or nothing where it carries none.
 *
 * This reads the URL the client built and handed to `present()`, never a
 * callback: its params are in the query, so a fragment is something else and is
 * left out of the read, which would otherwise be carried into the value and
 * produce a `state` that matches nothing. Callbacks go through the provider's
 * own parser instead, which is the only thing that knows where a given provider
 * puts them.
 */
function stateOfAuthorizationUrl(url: string): string | undefined {
  const questionMark = url.indexOf('?')

  if (questionMark === -1) {
    return undefined
  }

  const query = url.slice(questionMark + 1).split('#')[0]!

  return new URLSearchParams(query).get('state') ?? undefined
}

/**
 * Host forms that name one address outright. Nothing else can answer for them,
 * so a receiver advertising one of these already binds everything it promises.
 */
const ipLiteralHosts = new Set(['127.0.0.1', '::1', '[::1]'])

/** The other address a hostname like `localhost` routinely also resolves to. */
const siblingAddresses: Record<string, string> = { '127.0.0.1': '::1', '::1': '127.0.0.1' }

/**
 * A host written the way a URL authority requires.
 *
 * An IPv6 literal is only legal in an authority when it is bracketed, and a
 * bind host cannot be written that way: Node hands `'[::1]'` to the resolver,
 * which fails `ENOTFOUND`, so `'::1'` is the only spelling that ever binds the
 * IPv6 loopback interface. The two forms therefore disagree by construction,
 * and anything that interpolates a bind host into a URL has to reconcile them
 * itself — `new URL('/', 'http://::1')` throws `Invalid URL`.
 *
 * A host already carrying its brackets is left alone, because `ipLiteralHosts`
 * accepts `'[::1]'` as an advertised host and a caller may reasonably pass the
 * same string here.
 */
function urlAuthorityHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Names that mean "the loopback interface" rather than one address on it.
 *
 * A bind host given as a name is normalised to `127.0.0.1` before anything
 * reasons about siblings. Otherwise `loopbackReceiver({ host: 'localhost' })` —
 * a plausible reading of an option documented as "interface to bind" — would
 * bind whichever single address the resolver happened to prefer and find no
 * sibling to pair it with, silently reinstating the very gap this covers.
 */
const loopbackNames = new Set(['localhost'])

/** How many ephemeral ports to try before giving up on finding a clean pair. */
const EPHEMERAL_BIND_ATTEMPTS = 5

/**
 * Errno values that mean the address family is not available on this host at
 * all, as opposed to the address being taken.
 *
 * The distinction is the whole point. A machine with IPv6 disabled cannot
 * resolve `localhost` to `::1` either, so there is no address left for anyone
 * to squat and binding IPv4 alone is complete. A port *held* by someone else is
 * the opposite situation and must not be waved through.
 */
const familyUnavailable = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT'])

/**
 * The address a hostname resolves to besides `bindHost`, or `undefined` when
 * there is nothing extra to cover.
 */
function siblingBindHost(advertisedHost: string, bindHost: string): string | undefined {
  if (ipLiteralHosts.has(advertisedHost)) {
    return undefined
  }

  return siblingAddresses[bindHost]
}

/**
 * Retires one server.
 *
 * `closeAllConnections()` is not optional dressing: `close()` alone waits for
 * in-flight connections, and a client that has sent half a request holds one
 * open indefinitely — which would hang whoever awaited this.
 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

type BindOutcome = 'bound' | 'no-family' | 'in-use'

/** Binds without opinions, so the caller can tell "taken" from "not supported". */
async function tryListen(server: Server, port: number, host: string): Promise<BindOutcome> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening)

      if (error.code === 'EADDRINUSE') {
        resolve('in-use')

        return
      }

      if (error.code && familyUnavailable.has(error.code)) {
        resolve('no-family')

        return
      }

      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve('bound')
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening)

      if (error.code === 'EADDRINUSE') {
        reject(
          new OAuthError(
            'configuration_error',
            `Port ${port} on ${host} is already in use. Another login may be in ` +
              'progress, or another CLI is holding the port. Pass a different ' +
              '`port` (or 0 to pick a free one) if the provider allows it.',
            { cause: error },
          ),
        )

        return
      }

      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address() as AddressInfo | null
      resolve(address?.port ?? port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Receives the callback on a local HTTP server (RFC 8252 §7.3).
 *
 * This is how every AI CLI does desktop sign-in: bind 127.0.0.1, send the user
 * to the provider, and let the browser redirect back into the process. The
 * server handles exactly one callback and then shuts down, closing idle
 * keep-alive sockets that would otherwise hold it open.
 *
 * Only `GET` and `HEAD` are answered. The callback arrives as a browser
 * navigation, so nothing else is legitimate, and any local process can reach a
 * loopback port — a narrower surface is one less thing to reason about.
 *
 * The same reasoning extends to fetch metadata. Any page the user happens to
 * have open can issue a no-preflight `GET` at a loopback port, and two of the
 * bundled providers bind a fixed, published one. That request is not a
 * credential leak — the response is opaque to the page and `state` still has to
 * match — but a bare `?error=access_denied` would settle the callback promise
 * and kill a login that was in progress. So a request the browser itself labels
 * as a subresource is refused without touching the promise: `Sec-Fetch-Site`
 * present, not `none`, and `Sec-Fetch-Mode` something other than `navigate`.
 * The headers are only trusted when the browser sends them; curl, undici and
 * anything else non-browser send no `Sec-Fetch-Site` at all and are unaffected.
 *
 * That check cannot be the whole answer, and no tightening of it could be. The
 * provider's own redirect is a cross-site top-level navigation, so a page that
 * simply navigates the user to `http://127.0.0.1:1455/callback?error=...`
 * sends a byte-identical request — same `Sec-Fetch-Site: cross-site`, same
 * `navigate`, same `document` — and there is nothing in the metadata left to
 * tell them apart. `Sec-Fetch-User` is not it either: a provider that
 * auto-approves an already-consented app redirects without a gesture and sends
 * none. Only `state` separates the two.
 *
 * So the callback is also matched to the attempt, by the `state` read out of
 * the authorization URL this receiver was handed. One that disagrees — or that
 * carries no `state` where a state was presented — is refused without settling
 * the promise, and the server keeps listening for the real redirect. The
 * comparison runs in constant time because it now sits on a security boundary.
 *
 * Two gaps are left open deliberately. A receiver driven directly, without
 * `present()`, has no attempt to compare against and takes callbacks as they
 * come: `start()` binds a port, so unlike a deep-link channel there is no
 * pre-existing route for a stray callback to arrive on, and requiring
 * `present()` would break every caller that drives `start()` itself. And a
 * provider declaring `echoesState: false` has said no `state` will come back,
 * so holding it to a comparison it cannot satisfy would reject the only
 * callback it can send. The `Sec-Fetch-*` check above is what covers both, and
 * it is why that check runs first and stays.
 *
 * The callback promise is given a no-op `catch` at construction because it is
 * consumed only in `wait()`; without it, a callback that fails before anyone
 * calls `wait()` would surface as an unhandled rejection.
 */
export function loopbackReceiver(options: LoopbackReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'loopback',
    async start(context: ReceiverContext) {
      const { provider } = context
      const path = options.path ?? provider.redirect.loopbackPath ?? '/callback'
      const bindHost = options.host ?? '127.0.0.1'
      const primaryHost = loopbackNames.has(bindHost) ? '127.0.0.1' : bindHost
      const requestedPort = options.port ?? provider.redirect.loopbackPort ?? 0

      /**
       * The base an incoming request path is resolved against.
       *
       * Only `pathname` and `search` are read back out of the result, so this
       * is a syntactic placeholder and any valid host does the job. It is built
       * from `primaryHost` rather than the raw option because that is the value
       * that actually reached `listen()`, and it goes through
       * {@link urlAuthorityHost} because `host: '::1'` — the only spelling that
       * can bind the IPv6 loopback interface at all — is not a legal authority
       * unbracketed. Computed once here rather than per request: it cannot
       * change, and a throw down in the `request` handler has nowhere to go.
       */
      const requestBase = `http://${urlAuthorityHost(primaryHost)}`

      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })
      callbackPromise.catch(() => {})

      let settled = false

      /**
       * The `state` of the authorization this receiver actually presented,
       * learned from the URL it was handed rather than tracked separately, so
       * the two cannot disagree.
       *
       * There is no companion "has present() run" flag, unlike the deep-link
       * and popup receivers. Those listen on a channel that exists before the
       * flow does, so a callback arriving before `present()` is somebody
       * else's; a bound port does not exist until `start()` binds it, and a
       * caller may legitimately drive `start()` and never call `present()` at
       * all.
       */
      let presentedState: string | undefined

      /**
       * The provider's own read of the callback query, with the failure it may
       * represent held rather than thrown.
       *
       * The `state` has to come from the same parser the client will use:
       * providers disagree about where the callback params live, and
       * `parseCallback` is the only thing that knows which. Settling is held
       * back so ownership can be decided first — `readCallback` throws on an
       * `error=` callback, and that rejection is exactly what a page trying to
       * cancel this login would like to hand us.
       */
      const read = (
        search: string,
      ):
        | { state: string | undefined; result: CallbackResult }
        | { state: string | undefined; detail: string; failure: unknown } => {
        try {
          const result = readCallback(provider, search)

          return { state: result.state, result }
        } catch (error) {
          // `readCallback` carries the `state` its parse found onto the error
          // it throws, so even a refusal still says whose it is.
          const detail =
            error instanceof OAuthError
              ? (error.providerErrorDescription ?? error.providerError ?? error.message)
              : String(error)

          return { state: isOAuthError(error) ? error.state : undefined, detail, failure: error }
        }
      }

      /**
       * Whether a callback belongs to *this* receiver's attempt.
       *
       * Where nothing was presented there is nothing to compare and the
       * callback is taken as it comes; where a `state` was, silence is a
       * disagreement like any other, because a callback that cannot be shown to
       * be ours is exactly what a drive-by navigation produces. RFC 6749
       * §4.1.2.1 requires `state` to be echoed on an error response as well as
       * a successful one, so nothing conforming is turned away.
       *
       * A provider declaring `echoesState: false` is the "nothing to compare"
       * case even though the authorization URL carried a `state`, because it
       * has said the callback will not bring one back. The client draws the
       * same exception at the same boundary, with the same caveat: such a
       * provider cannot tell two concurrent attempts apart, which is fine for a
       * CLI and is not safe in a multi-user server.
       */
      const belongsToThisAttempt = (state: string | undefined): boolean =>
        presentedState === undefined ||
        provider.echoesState === false ||
        timingSafeEqual(state ?? '', presentedState)

      /**
       * Settles the callback exactly once and then retires the server, so the
       * receiver really does serve one callback and no more: a second request
       * cannot overwrite the first result, and after the port is gone it cannot
       * arrive at all. Closing waits for the response to flush, because
       * `close()` destroys the sockets and would otherwise cut off the page the
       * user is looking at.
       */
      const settle = (response: ServerResponse, done: () => void): void => {
        if (settled) {
          return
        }

        settled = true
        done()

        if (response.writableFinished) {
          void close()

          return
        }

        response.once('close', () => void close())
      }

      const serveRequest = (request: IncomingMessage, response: ServerResponse): void => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' })
          response.end('Method not allowed')

          return
        }

        // A browser labels the provider's redirect `Sec-Fetch-Mode: navigate`
        // and `Sec-Fetch-Dest: document`. `<img>`, `fetch()` and friends carry
        // `no-cors`/`cors` instead, so a page cannot use one to settle — and
        // thereby cancel — a live login. `none` is a typed-in URL, which is
        // legitimate; a missing header means a non-browser client, which this
        // check has no opinion about.
        //
        // The destination is load-bearing, not belt-and-braces. A hidden
        // cross-origin `<iframe>` is a navigation too, so mode alone lets it
        // through, and `http://127.0.0.1` counts as a potentially trustworthy
        // origin — mixed content does not block one embedded in an https page.
        // That is the same drive-by with nothing for the user to notice. Only
        // `document` is a real redirect back from the provider; `iframe`,
        // `frame`, `object` and `embed` are not.
        const fetchSite = request.headers['sec-fetch-site']
        const fetchDest = request.headers['sec-fetch-dest']

        if (
          typeof fetchSite === 'string' &&
          fetchSite !== 'none' &&
          (request.headers['sec-fetch-mode'] !== 'navigate' ||
            (typeof fetchDest === 'string' && fetchDest !== 'document'))
        ) {
          response.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/plain' })
          response.end('Forbidden')

          return
        }

        const url = new URL(request.url ?? '/', requestBase)

        if (url.pathname !== path) {
          response.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain' })
          response.end('Not found')

          return
        }

        // Read before responding, so ownership is decided before anything is
        // written and before anything is settled. A callback that is not ours
        // must leave the pending promise and the server exactly as it found
        // them — the damage a drive-by does is not the response it gets, it is
        // that settling closes the port the real redirect is about to arrive
        // on.
        const callback = read(url.search)

        if (!belongsToThisAttempt(callback.state)) {
          response.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/plain' })
          response.end('Forbidden')

          return
        }

        if ('failure' in callback) {
          response.writeHead(400, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' })
          response.end((options.failureHtml ?? defaultFailureHtml)(callback.detail))
          settle(response, () => rejectCallback(callback.failure))

          return
        }

        response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' })
        response.end(options.successHtml ?? DEFAULT_SUCCESS_HTML)
        settle(response, () => resolveCallback(callback.result))
      }

      /**
       * Serves one request, and never lets a throw escape into the `request`
       * event.
       *
       * Nothing on that stack can catch one. There is no `try` above it; the
       * server's `error` event reports socket failures, not handler throws; and
       * `login()`'s own `try` sits on a different stack that returned the
       * moment `start()` resolved. So an exception here reaches Node's uncaught
       * handler and takes the process down — a CLI exiting 1 with a stack trace
       * in the middle of a sign-in it was moments from completing.
       *
       * The refusal is deliberately inert. It writes a 400 and leaves the
       * pending promise and the bound port exactly as it found them, which is
       * the same posture the drive-by refusals above take and for the same
       * reason: a request this receiver could not make sense of must not cancel
       * a login whose real redirect is still on its way. `settle()` is what
       * retires the server, so not calling it is what keeps "one callback, then
       * close" meaning one *callback* rather than one request.
       *
       * Headers already on the wire are left alone — writing them twice throws
       * `ERR_HTTP_HEADERS_SENT`, from a `catch` with nowhere left to report to
       * — and a response already ended is not ended again. Either way the
       * socket is not left hanging.
       */
      const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
        try {
          serveRequest(request, response)
        } catch {
          if (response.writableEnded) {
            return
          }

          if (!response.headersSent) {
            response.writeHead(400, { ...securityHeaders, 'Content-Type': 'text/plain' })
          }

          response.end('Bad request')
        }
      }

      const server = createServer(handleRequest)
      /* Every address currently answering for the advertised name. */
      const servers: Server[] = [server]

      /**
       * Safe to call more than once, which it now is: `settle()` closes the
       * server as soon as a callback has been served, and the caller closes it
       * again in `login()`'s `finally`. `server.close()` on a server that has
       * already gone still invokes its callback — with an
       * `ERR_SERVER_NOT_RUNNING` there is nothing to do about — so the second
       * call resolves rather than hanging.
       */
      const close = async (): Promise<void> => {
        await Promise.all(servers.map(closeServer))
      }

      /**
       * Binds every address the advertised host resolves to, not just one.
       *
       * The receiver binds `127.0.0.1`, but the redirect URI it hands the
       * authorization server names `localhost` for four of the five bundled
       * providers. On a dual-stack machine `localhost` resolves to `::1` as
       * well — Chromium puts `::1` first and Happy Eyeballs tries it first — so
       * another local user can bind `[::1]:<port>` and receive the callback
       * while our own bind succeeds and the login looks entirely normal. Port
       * reservation is per address, not per name, so the `EADDRINUSE` guard
       * below never sees it. RFC 8252 §7.3 recommends the IP literal for
       * exactly this reason, but OpenAI registered the `localhost` form, so the
       * fix has to be to own the name rather than to stop using it.
       *
       * Failing to bind the sibling is only an error when something is *holding*
       * it. A host with IPv6 disabled cannot resolve `localhost` to `::1`
       * either, so there is nothing there to take and IPv4 alone is complete.
       *
       * A fixed published port gets one attempt, because a squatted sibling is
       * the attack and there is no other port to move to. An ephemeral port may
       * simply have collided with something already there, so it takes another —
       * an attacker holding a wide swathe of the range makes this likely enough
       * to matter, and each retry is a fresh draw.
       */
      const listenOnEveryAddress = async (): Promise<number> => {
        const advertisedHost =
          options.redirectHost ?? provider.redirect.loopbackHost ?? 'localhost'
        const siblingHost = siblingBindHost(advertisedHost, primaryHost)

        if (!siblingHost) {
          return listen(server, requestedPort, primaryHost)
        }

        const attempts = requestedPort === 0 ? EPHEMERAL_BIND_ATTEMPTS : 1

        /* Anything thrown from here escapes `start()`, and a caller that never
           received a receiver has nothing to call `close()` on — `login()` binds
           `started` outside its own `try`. So a failure that leaves the primary
           listening would hold the port for the life of the process: the CLI,
           which sets `process.exitCode` rather than calling `process.exit`,
           would never terminate, and a second attempt would collide with our own
           socket and report "already in use" instead of the real reason. */
        try {
          for (let attempt = 1; attempt <= attempts; attempt++) {
            const port = await listen(server, requestedPort, primaryHost)
            const sibling = createServer(handleRequest)
            const outcome = await tryListen(sibling, port, siblingHost)

            if (outcome === 'bound') {
              servers.push(sibling)

              return port
            }

            if (outcome === 'no-family') {
              return port
            }

            if (attempt === attempts) {
              throw new OAuthError(
                'configuration_error',
                `Port ${port} on ${siblingHost} is held by another process, but the redirect ` +
                  `URI for this login names "${advertisedHost}", which resolves to both ` +
                  `${primaryHost} and ${siblingHost}. The browser may hand the authorization ` +
                  'code to whoever holds the other address, so this login was refused rather ' +
                  'than started. Free that port, or pass `redirectHost: \'127.0.0.1\'` to ' +
                  'loopbackReceiver() if the provider accepts the IP literal.',
              )
            }

            /* Release the port we took so the retry is a genuinely fresh draw. */
            await closeServer(server)
          }

          /* Unreachable: the loop either returns or throws on its last attempt. */
          throw new OAuthError('configuration_error', 'Could not bind a loopback port.')
        } catch (error) {
          await close()

          throw error
        }
      }

      const boundPort = await listenOnEveryAddress()

      const onAbort = () => {
        settled = true
        rejectCallback(new OAuthError('aborted', 'Login was aborted.'))
        void close()
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })

      const redirectProvider = {
        ...provider,
        redirect: {
          ...provider.redirect,
          ...(options.redirectHost ? { loopbackHost: options.redirectHost } : {}),
          loopbackPath: path,
        },
      }

      return {
        redirectUri: buildLoopbackRedirectUri(redirectProvider, boundPort),
        async present(url) {
          // Read from the URL the client built rather than tracked alongside
          // it, so what this receiver believes its attempt is can never drift
          // from what it actually sent the user to.
          presentedState = stateOfAuthorizationUrl(url)

          options.onAuthorizationUrl?.(url)

          if (context.openUrl) {
            await context.openUrl(url)
          } else if (options.openBrowser !== false) {
            openBrowser(url)
          }
        },
        wait: () => callbackPromise,
        async close() {
          context.signal?.removeEventListener('abort', onAbort)
          await close()
        },
      }
    },
  }
}
