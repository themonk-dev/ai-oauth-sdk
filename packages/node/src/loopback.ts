import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  OAuthError,
  buildLoopbackRedirectUri,
  readCallback,
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
  /** Interface to bind. Defaults to 127.0.0.1 — never bind 0.0.0.0 for this. */
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
 * Host forms that name one address outright. Nothing else can answer for them,
 * so a receiver advertising one of these already binds everything it promises.
 */
const ipLiteralHosts = new Set(['127.0.0.1', '::1', '[::1]'])

/** The other address a hostname like `localhost` routinely also resolves to. */
const siblingAddresses: Record<string, string> = { '127.0.0.1': '::1', '::1': '127.0.0.1' }

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
      const requestedPort = options.port ?? provider.redirect.loopbackPort ?? 0

      let resolveCallback: (result: CallbackResult) => void
      let rejectCallback: (error: unknown) => void
      const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })
      callbackPromise.catch(() => {})

      let settled = false

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

      const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
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

        const url = new URL(request.url ?? '/', `http://${bindHost}`)

        if (url.pathname !== path) {
          response.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain' })
          response.end('Not found')

          return
        }

        let result: CallbackResult

        try {
          result = readCallback(provider, url.search)
        } catch (error) {
          const detail =
            error instanceof OAuthError
              ? (error.providerErrorDescription ?? error.providerError ?? error.message)
              : String(error)
          response.writeHead(400, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' })
          response.end((options.failureHtml ?? defaultFailureHtml)(detail))
          settle(response, () => rejectCallback(error))

          return
        }

        response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' })
        response.end(options.successHtml ?? DEFAULT_SUCCESS_HTML)
        settle(response, () => resolveCallback(result))
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
        await Promise.all(
          servers.map(
            (each) =>
              new Promise<void>((resolve) => {
                each.close(() => resolve())
                each.closeAllConnections?.()
              }),
          ),
        )
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
        const siblingHost = siblingBindHost(advertisedHost, bindHost)

        if (!siblingHost) {
          return listen(server, requestedPort, bindHost)
        }

        const attempts = requestedPort === 0 ? 5 : 1

        for (let attempt = 1; attempt <= attempts; attempt++) {
          const port = await listen(server, requestedPort, bindHost)
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
                `${bindHost} and ${siblingHost}. The browser may hand the authorization code ` +
                'to whoever holds the other address, so this login was refused rather than ' +
                'started. Free that port, or pass `redirectHost: \'127.0.0.1\'` to ' +
                'loopbackReceiver() if the provider accepts the IP literal.',
            )
          }

          /* Release the port we took so the retry is a genuinely fresh draw. */
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }

        /* Unreachable: the loop either returns or throws on its last attempt. */
        throw new OAuthError('configuration_error', 'Could not bind a loopback port.')
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
