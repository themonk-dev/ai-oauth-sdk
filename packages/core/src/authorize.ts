import { appendQuery } from './query.js'
import type { ProviderConfig } from './types.js'

export interface BuildAuthorizationUrlInput {
  provider: ProviderConfig
  clientId: string
  redirectUri: string
  state: string
  codeChallenge?: string
  codeChallengeMethod?: string
  scopes?: string[]
  /**
   * Merged over the provider's own `extraAuthParams`. The protocol parameters
   * — `response_type`, `client_id`, `redirect_uri`, `state`, `scope` and the
   * PKCE pair — cannot be overridden from here; they are written last.
   */
  extraParams?: Record<string, string>
}

export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const { provider } = input

  /* The extras go in first so the parameters that bind this request to this
     flow are written over them, not under them. `scope` and the PKCE pair were
     already assigned after the spread and so were already safe; the four here
     were not, and a caller-supplied map could quietly replace the `state` we
     minted or the `redirect_uri` we registered.

     This is defence in depth rather than a hole being closed. The flow already
     fails shut end to end: the pending record keeps the honest `state`, so
     `login()`'s constant-time comparison rejects the substituted one as
     `state_mismatch`, the manual path finds no record and throws
     `unknown_state`, and the exchange replays the honest `pending.redirectUri`
     regardless of what went out on the authorize URL. What this buys is that
     the guarantee is structural — readable at the point the URL is built,
     rather than reconstructed from three checks elsewhere.

     `provider.buildAuthParams` below still gets the last word. That is
     descriptor configuration written alongside the endpoints it belongs to,
     not caller input. */
  const params: Record<string, string> = {
    ...provider.extraAuthParams,
    ...input.extraParams,
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
  }

  const scopes = input.scopes ?? provider.scopes

  if (scopes.length) {
    params['scope'] = scopes.join(' ')
  }

  if (input.codeChallenge) {
    params['code_challenge'] = input.codeChallenge
    params['code_challenge_method'] = input.codeChallengeMethod ?? provider.pkceMethod
  }

  const finalParams = provider.buildAuthParams ? provider.buildAuthParams(params) : params

  const supplied: Record<string, string> = {}

  for (const [key, value] of Object.entries(finalParams)) {
    if (value !== undefined && value !== '') {
      supplied[key] = value
    }
  }

  return appendQuery(provider.authorizationUrl, supplied)
}

/** Builds the loopback redirect URI a provider expects for a given port. */
export function buildLoopbackRedirectUri(provider: ProviderConfig, port: number): string {
  const host = provider.redirect.loopbackHost ?? 'localhost'
  const path = provider.redirect.loopbackPath ?? '/callback'

  return `http://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * The redirect URI to use when the caller did not specify one, derived from the
 * provider's declared mode.
 */
export function defaultRedirectUri(provider: ProviderConfig): string | undefined {
  const { redirect } = provider

  if (redirect.mode === 'hosted') {
    return redirect.hostedUri
  }

  if (redirect.mode === 'loopback' && redirect.loopbackPort) {
    return buildLoopbackRedirectUri(provider, redirect.loopbackPort)
  }

  return undefined
}
