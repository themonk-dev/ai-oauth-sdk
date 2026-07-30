import {
  parseStandardCallback,
  type AuthClient,
  type CallbackReceiver,
  type CallbackResult,
  type TokenSet,
} from '@ai-oauth-sdk/core'

export interface RedirectReceiverOptions {
  /** Where the provider sends the user back. Defaults to the current URL. */
  redirectUri?: string
  /** Navigate with `replace` so login does not add a history entry. Default true. */
  replace?: boolean
}

/**
 * Navigates the whole page to the provider and back.
 *
 * The most compatible browser option — no popup blockers, works in embedded
 * webviews — at the cost of losing all in-memory state. The flow therefore
 * spans two page loads and is completed by {@link handleRedirectCallback} on
 * the way back, which is why the client must use a persistent storage adapter
 * (`sessionStorageAdapter()` is the default in {@link createBrowserAuthClient}).
 *
 * `wait()` never settles here: the page is unloading. Use
 * {@link startRedirectLogin} rather than `client.login()` to make that explicit.
 */
export function redirectReceiver(options: RedirectReceiverOptions = {}): CallbackReceiver {
  return {
    id: 'redirect',
    async start() {
      const redirectUri = options.redirectUri ?? window.location.href.split('#')[0]!
      return {
        redirectUri,
        async present(url) {
          if (options.replace === false) {
            window.location.assign(url)
          } else {
            window.location.replace(url)
          }
        },
        // The document is being torn down; nothing can resolve.
        wait: () => new Promise<CallbackResult>(() => {}),
        async close() {
          /* nothing to tear down */
        },
      }
    },
  }
}

/**
 * Starts a full-page redirect login. Does not return — the page navigates away.
 */
export async function startRedirectLogin(
  client: AuthClient,
  options: RedirectReceiverOptions & { scopes?: string[]; metadata?: Record<string, unknown> } = {},
): Promise<never> {
  const redirectUri = options.redirectUri ?? window.location.href.split('#')[0]!
  const authorization = await client.createAuthorization({
    redirectUri,
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })

  if (options.replace === false) {
    window.location.assign(authorization.url)
  } else {
    window.location.replace(authorization.url)
  }

  // Give the navigation a turn to happen; never resolves in practice.
  return new Promise<never>(() => {})
}

export interface HandleRedirectCallbackOptions {
  /** URL to read the callback from. Defaults to `window.location.href`. */
  url?: string
  /** Strip `code`/`state` from the address bar afterwards. Default true. */
  cleanUrl?: boolean
}

/**
 * Completes a redirect login on page load.
 *
 * Returns `null` when the current URL is not a callback, so it is safe to call
 * unconditionally during app startup:
 *
 * ```ts
 * const tokens = await handleRedirectCallback(client)
 * if (tokens) console.log('signed in as', tokens.email)
 * ```
 */
export async function handleRedirectCallback(
  client: AuthClient,
  options: HandleRedirectCallbackOptions = {},
): Promise<TokenSet | null> {
  const href = options.url ?? window.location.href
  const parse = client.provider.parseCallback ?? parseStandardCallback
  const parsed = parse(href)

  if (!parsed.code && !parsed.error) {
    return null
  }

  try {
    // Hand the whole URL over rather than re-deriving the failure here: this is
    // the path that also fails anyone blocked in `waitForAuthorization`, which
    // a locally-thrown error would leave hanging until its timeout.
    return await client.completeAuthorization({ callbackUrl: href })
  } finally {
    // Only rewrite the address bar when the callback actually came from it.
    // With an explicit `url` the caller is parsing something else — a stored
    // deep link, a test fixture — and navigating the page to it would be wrong.
    const cameFromAddressBar = options.url === undefined
    if (options.cleanUrl !== false && cameFromAddressBar && typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      for (const key of ['code', 'state', 'error', 'error_description', 'scope']) {
        url.searchParams.delete(key)
      }
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    }
  }
}
