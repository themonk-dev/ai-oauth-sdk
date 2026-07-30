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

function page(title: string, message: string, accent: string): string {
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
    <div class="dot">${accent === '#16a34a' ? '&#10003;' : '&#33;'}</div>
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
)

const defaultFailureHtml = (error: string) =>
  page('Sign-in failed', escapeHtml(error), '#dc2626')

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
 * server handles exactly one callback and then shuts down.
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
      // The promise is consumed only in `wait()`; without this, a callback that
      // errors before `wait()` is called would surface as an unhandled rejection.
      callbackPromise.catch(() => {})

      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        // The callback arrives as a browser navigation, so nothing else is
        // legitimate. Any local process can reach a loopback port, and a
        // narrower surface is one less thing to reason about.
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' })
          response.end('Method not allowed')
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
          // The page shows the provider's own wording where there is one; the
          // full error still goes to the caller.
          const detail =
            error instanceof OAuthError
              ? (error.providerErrorDescription ?? error.providerError ?? error.message)
              : String(error)
          response.writeHead(400, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' })
          response.end((options.failureHtml ?? defaultFailureHtml)(detail))
          rejectCallback(error)
          return
        }

        response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' })
        response.end(options.successHtml ?? DEFAULT_SUCCESS_HTML)
        resolveCallback(result)
      })

      const boundPort = await listen(server, requestedPort, bindHost)

      const close = async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Idle keep-alive sockets would otherwise hold the server open.
          server.closeAllConnections?.()
        })
      }

      const onAbort = () => {
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
