import { buildLoopbackRedirectUri, type ProviderConfig } from '@ai-oauth-sdk/core'

/**
 * The parts of a page's origin {@link resolveBrowserFlow} needs to decide
 * anything — structural rather than `Location` itself, so a server render or
 * a test can construct one without touching `window`. `window.location` in a
 * browser satisfies this type as-is (excess properties are fine on a value,
 * only object literals get the excess-property check), so
 * `resolveBrowserFlow(provider, window.location)` works without conversion.
 */
export interface BrowserOrigin {
  /** `'http:'` or `'https:'`, matching `location.protocol`. */
  protocol: string
  hostname: string
  /** `''` for the protocol's default port, matching `location.port`. */
  port: string
}

/**
 * What to tell the user about a paste-back flow, derived from what the
 * provider's redirect will actually do once they authorize.
 */
export type PasteHint =
  | {
      /** The provider hosts a page that displays the code — the common case. */
      kind: 'hosted'
      message: string
    }
  | {
      /**
       * Nothing is listening at the redirect (a loopback port, or a custom URI
       * this origin cannot serve) — the browser lands on a page that fails to
       * load, and the code exists only in that dead address bar.
       */
      kind: 'unreachable'
      message: string
    }
  | {
      /**
       * The provider would redirect straight back to this page and the popup
       * flow would work — but only from an `https` origin, and this one is
       * cleartext. Distinct from `unreachable` because the remedy is entirely
       * different: nothing is broken about the redirect address, and telling
       * this user that the page "will fail to load" and to read the address bar
       * describes something that will not happen. What they need to hear is
       * that the origin has to be secure.
       */
      kind: 'insecure-origin'
      message: string
    }

export type BrowserFlowResolution =
  | {
      flow: 'popup'
      /** The redirect URI this origin can offer the provider. */
      redirectUri: string
    }
  | {
      flow: 'device'
      /**
       * Something the user must do before a device code can be approved,
       * when the provider declares one. Omitting this from a UI produces a
       * code that can never be approved — see `openai`'s descriptor.
       */
      devicePrerequisite?: string
    }
  | {
      flow: 'paste'
      hint: PasteHint
    }

/**
 * The hostnames that mean "this machine", spelled the way a `Location` spells
 * them.
 *
 * IPv6 is bracketed here, and that is not cosmetic. `location.hostname` keeps
 * the brackets an IPv6 host is written with — `new URL('http://[::1]:5173/')
 * .hostname` is `'[::1]'`, not `'::1'` — so a bare `'::1'` entry matches no
 * real origin and an app served from `http://[::1]:5173/` falls all the way
 * through to `paste` while the same app on `http://localhost:5173/` gets a
 * popup. The bare form is also worse than dead if anything ever did reach it:
 * `originRoot` concatenates the hostname without adding brackets back, so it
 * would build `http://::1:5173/`, which `new URL()` refuses outright. Only the
 * bracketed spelling is correct, which is the spelling
 * `providers/index.ts` already uses for the same job.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackOrigin(origin: BrowserOrigin): boolean {
  return LOOPBACK_HOSTNAMES.has(origin.hostname)
}

function originRoot(origin: BrowserOrigin): string {
  return `${origin.protocol}//${origin.hostname}${origin.port ? `:${origin.port}` : ''}/`
}

function numericPort(origin: BrowserOrigin): number {
  if (origin.port !== '') {
    return Number(origin.port)
  }

  return origin.protocol === 'https:' ? 443 : 80
}

/**
 * True when a loopback origin's own host and port are exactly the ones the
 * provider registered — the free case described in the design note: an app
 * that happens to be served from `localhost:1455` satisfies OpenAI's fixed
 * redirect without OpenAI having to accept anything but that one address.
 */
function matchesFixedLoopback(provider: ProviderConfig, origin: BrowserOrigin): boolean {
  const { loopbackPort, loopbackHost } = provider.redirect

  if (!loopbackPort) {
    return false
  }

  return numericPort(origin) === loopbackPort && (loopbackHost ?? 'localhost') === origin.hostname
}

/**
 * Decides which browser sign-in flow will actually work for a provider,
 * served from a given origin. Pure and synchronous: no `window` access, so
 * the server case (no browser at all) is a value a caller passes rather than
 * something this function has to detect.
 *
 * Rules, in order — first match wins:
 *
 * 1. This origin can offer a redirect URI the provider's client accepts →
 *    `popup`. Three ways that happens: the origin is an `https` one that is not
 *    loopback and the provider accepts an arbitrary HTTPS redirect
 *    (`openrouter`, which registers no redirect against a client at all —
 *    `claude` deliberately declares `false` here, since its authorize endpoint
 *    renders consent for an HTTPS redirect but the grant then fails on the
 *    redirect URI; see `providers/claude.ts`); the origin is loopback and the
 *    provider accepts any port (`loopbackPort: 0`, RFC 8252); or the origin is
 *    loopback on exactly the host and port a *fixed* loopback redirect names.
 * 2. The provider supports a device flow (`deviceAuthorizationUrl` or the
 *    `deviceFlow` override — OpenAI's device flow is not RFC 8628, so it only
 *    ever declares the latter) → `device`.
 * 3. Otherwise → `paste`. A `hostedUri` means the provider itself shows the
 *    code; a cleartext origin that rule 1 would otherwise have served gets the
 *    `insecure-origin` hint; without either, the redirect lands on an address
 *    nothing here can answer, and the address bar is the only place the code
 *    appears.
 *
 * The scheme test in rule 1 is not decoration. `acceptsHttpsRedirect` names what
 * the provider will accept, and the check used to read "not loopback" alone
 * while `originRoot` copies `origin.protocol` verbatim — so an app served from a
 * non-loopback *cleartext* origin (`http://192.168.1.50:8080/`, an intranet
 * `http://tools.corp.lan/`) had that `http` URL handed to the provider as its
 * redirect. For `openrouter` it goes on the wire as `callback_url`, and the
 * authorization code then comes back over cleartext to anyone on the path. A
 * loopback origin is exempt because traffic there never leaves the machine, and
 * it is rule 2 that catches it — the same exemption RFC 8252 §8.3 makes and that
 * `providers/index.ts` makes for discovered endpoints.
 */
export function resolveBrowserFlow(
  provider: ProviderConfig,
  origin: BrowserOrigin,
): BrowserFlowResolution {
  const loopback = isLoopbackOrigin(origin)
  const secure = origin.protocol === 'https:'

  if (!loopback && secure && provider.redirect.acceptsHttpsRedirect === true) {
    return { flow: 'popup', redirectUri: originRoot(origin) }
  }

  if (loopback && provider.redirect.loopbackPort === 0) {
    return { flow: 'popup', redirectUri: originRoot(origin) }
  }

  if (loopback && matchesFixedLoopback(provider, origin)) {
    return {
      flow: 'popup',
      redirectUri: buildLoopbackRedirectUri(provider, provider.redirect.loopbackPort!),
    }
  }

  if (provider.deviceAuthorizationUrl || provider.deviceFlow) {
    return {
      flow: 'device',
      ...(provider.devicePrerequisite ? { devicePrerequisite: provider.devicePrerequisite } : {}),
    }
  }

  if (provider.redirect.hostedUri) {
    return {
      flow: 'paste',
      hint: {
        kind: 'hosted',
        message: `${provider.label} shows the code on its own page after you sign in — copy it back here.`,
      },
    }
  }

  /*
   * Reached only when rule 1 was the rule that would have applied and the
   * origin's scheme is the single thing standing in the way. Placed after the
   * device and hosted branches on purpose: neither needs a redirect back to this
   * page at all, so neither is affected by the origin being cleartext, and both
   * remain the better answer where the provider offers them.
   */
  if (!loopback && !secure && provider.redirect.acceptsHttpsRedirect === true) {
    return {
      flow: 'paste',
      hint: {
        kind: 'insecure-origin',
        message:
          `${provider.label} will redirect straight back to this page, but only from a secure ` +
          `origin, and this page is served over ${origin.protocol.replace(':', '')}. An ` +
          'authorization code delivered over cleartext is readable by anyone on the network path, ' +
          'so it is not offered here. Serve this app over https — or from localhost — to sign in ' +
          'without copying anything. Until then, sign in and copy the code back here.',
      },
    }
  }

  return {
    flow: 'paste',
    hint: {
      kind: 'unreachable',
      message:
        `${provider.label} will redirect to an address nothing here is listening on, so the page ` +
        'will fail to load. Copy the whole address bar rather than closing the window — the code ' +
        'exists nowhere else.',
    },
  }
}
