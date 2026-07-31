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
  /** Merged over the provider's own `extraAuthParams`. */
  extraParams?: Record<string, string>
}

export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const { provider } = input

  const params: Record<string, string> = {
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    ...provider.extraAuthParams,
    ...input.extraParams,
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
