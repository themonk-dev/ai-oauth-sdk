import { spawn } from 'node:child_process'

import {
  buildLoopbackRedirectUri,
  defineProvider,
  isOAuthError,
  providers,
  publicClientIds,
  publicClientSecrets,
  resolveProvider,
  type AuthClient,
  type ProviderConfig,
  type TokenSet,
} from '@ai-oauth-sdk/core'
import {
  createNodeAuthClient,
  defaultAuthDir,
  defaultReceiver,
  fileStorage,
  listStoredSessions,
  hybridReceiver,
  loopbackReceiver,
  promptReceiver,
} from '@ai-oauth-sdk/node'

import { flagBoolean, flagNumber, flagString, type ParsedArgs } from './args.js'
import { bold, cyan, dim, formatExpiry, info, output, outputJson, success, table, warn } from './output.js'

export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

interface CommandContext {
  args: ParsedArgs
  json: boolean
}

/**
 * Builds a provider from `--authorize-url`/`--token-url`, so the CLI works with
 * any OAuth 2.0 provider, not only the built-ins.
 *
 * A built-in id is refused rather than overridden. The descriptor built here
 * keeps `id: providerId`, and that id is what everything else is keyed on: the
 * tokens live at `tokens:<id>`, and `resolveClientId`/the client-secret
 * fallback below read `publicClientIds[id]`/`publicClientSecrets[id]`. So
 * `login gemini --token-url https://staging.internal/token` does not describe a
 * separate provider that happens to share a name — it sends the real Google
 * refresh token and Google's published client secret to whatever endpoint was
 * named, and reports success. Nobody points a built-in at a different token
 * endpoint meaning that; they mean "a provider of my own", which needs an id of
 * its own. The rest of the file already draws that line — `login` refuses to
 * `rememberProvider` a built-in id — so this closes the one path that was not.
 *
 * A remembered custom id is the same hazard with a different owner for the
 * "known endpoints"; `assertEndpointsMatch` covers that one.
 */
function customProvider(providerId: string, args: ParsedArgs): ProviderConfig | undefined {
  const authorizationUrl = flagString(args.flags, 'authorize-url')
  const tokenUrl = flagString(args.flags, 'token-url')

  if (!authorizationUrl && !tokenUrl) {
    return undefined
  }

  if (providerId in providers) {
    throw new CliError(
      `"${providerId}" is a built-in provider — --authorize-url/--token-url would point it at ` +
        'different endpoints while it still uses the credentials stored under that id.',
      `Give the custom provider an id of its own, e.g. ai-oauth-sdk login ${providerId}-staging --authorize-url … --token-url …`,
    )
  }

  if (!authorizationUrl || !tokenUrl) {
    throw new CliError(
      '--authorize-url and --token-url must be given together.',
      'Both endpoints are needed to run an authorization-code flow.',
    )
  }

  const scopes = flagString(args.flags, 'scopes')
  const deviceUrl = flagString(args.flags, 'device-url')
  const port = flagNumber(args.flags, 'port')
  const clientId = flagString(args.flags, 'client-id')

  return defineProvider({
    id: providerId,
    label: providerId,
    authorizationUrl,
    tokenUrl,
    ...(deviceUrl ? { deviceAuthorizationUrl: deviceUrl } : {}),
    ...(clientId ? { clientId } : {}),
    scopes: scopes ? scopes.split(/[\s,]+/).filter(Boolean) : [],
    redirect: { mode: 'loopback', loopbackPort: port ?? 0, loopbackPath: '/callback' },
  })
}

const PROVIDER_KEY_PREFIX = 'provider:'

function storageFor(args: ParsedArgs) {
  const authDir = flagString(args.flags, 'auth-dir')

  return fileStorage(authDir ? { dir: authDir } : {})
}

/**
 * Where a custom provider's descriptor lives, keyed the way its tokens are.
 *
 * Tokens are stored per account — `tokens:<id>` for the default one,
 * `tokens:<id>:<account>` for a named one — and the descriptor records the
 * endpoints *that* credential was minted against, so it has to be keyed
 * alongside it. A single `provider:<id>` shared by every account is rewritten
 * by whichever account signed in last, which turns the endpoint check upside
 * down: an account whose own endpoints no longer match the shared descriptor is
 * refused its correct invocation, while the same command with no flags at all
 * runs its credential against the *other* account's endpoints — exactly the
 * hazard the check exists to close.
 */
function descriptorKey(providerId: string, args: ParsedArgs): string {
  const accountKey = flagString(args.flags, 'account')

  return PROVIDER_KEY_PREFIX + providerId + (accountKey ? `:${accountKey}` : '')
}

/**
 * Remembers a custom provider's descriptor next to its tokens.
 *
 * Without this, `ai-oauth-sdk login acme --authorize-url … --token-url …` would
 * work but every later `token`/`refresh`/`whoami` would fail with
 * "unknown provider", since only the built-ins are resolvable by id.
 *
 * The client secret is deliberately dropped. It arrives as a flag, so it is
 * already in the process table and the shell history; writing it to the
 * credential file too would turn a transient exposure into a durable one. Later
 * commands re-read it from `--client-secret` or `AI_OAUTH_SDK_CLIENT_SECRET`.
 */
async function rememberProvider(provider: ProviderConfig, args: ParsedArgs): Promise<void> {
  const { clientSecret: _omitted, ...withoutSecret } = provider
  await storageFor(args).set(descriptorKey(provider.id, args), JSON.stringify(withoutSecret))
}

/**
 * Reads back the descriptor for this id and account.
 *
 * Descriptors written before they were keyed per account sit at the unsuffixed
 * `provider:<id>`, and an account that has not signed in since is still
 * resolvable only through them, so that key is the fallback — never the
 * preference, since a per-account descriptor is the one that actually describes
 * the credential in hand.
 */
async function recallProvider(
  providerId: string,
  args: ParsedArgs,
): Promise<ProviderConfig | undefined> {
  const storage = storageFor(args)
  const key = descriptorKey(providerId, args)
  const legacyKey = PROVIDER_KEY_PREFIX + providerId
  const stored =
    (await storage.get(key)) ?? (key === legacyKey ? undefined : await storage.get(legacyKey))

  if (!stored) {
    return undefined
  }

  try {
    return JSON.parse(stored) as ProviderConfig
  } catch {
    return undefined
  }
}

/** The endpoint flags that have to agree with what a session was minted against. */
const COMPARED_ENDPOINTS = [
  ['authorizationUrl', '--authorize-url'],
  ['tokenUrl', '--token-url'],
] as const

/**
 * One endpoint reduced to what actually decides where a credential goes.
 *
 * `undefined` for anything that is not a URL, which has no canonical form to
 * compare.
 */
function canonicalEndpoint(endpoint: string): string | undefined {
  let parsed: URL

  try {
    parsed = new URL(endpoint)
  } catch {
    return undefined
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}${parsed.search}${parsed.hash}`
}

/**
 * Whether two spellings name the same endpoint.
 *
 * Compared as URLs rather than as strings, because the differences that carry
 * no meaning — host case, an explicit default port, a trailing slash on the
 * path — are exactly the ones a saved command line collects, and refusing them
 * breaks working scripts without protecting anybody. `URL` lowercases the
 * scheme and host and drops a default port; the one further liberty taken here
 * is a single trailing slash, since `/token` and `/token/` are the same
 * resource to every server that serves either.
 *
 * Everything that could send the credential somewhere else still counts:
 * scheme, host, port, path, query and fragment. Something unparseable is
 * compared verbatim rather than waved through.
 */
function sameEndpoint(stored: string, given: string): boolean {
  const canonicalStored = canonicalEndpoint(stored)
  const canonicalGiven = canonicalEndpoint(given)

  if (canonicalStored === undefined || canonicalGiven === undefined) {
    return stored === given
  }

  return canonicalStored === canonicalGiven
}

/**
 * Refuses to run a stored session against endpoints it was not signed in
 * against.
 *
 * `customProvider` only guards built-in ids, on the reasoning that a built-in's
 * credentials are not the flags' to re-aim. A remembered custom provider is in
 * exactly the same position: the descriptor records the endpoints the session's
 * tokens were minted against (see `descriptorKey`), and the flags rebuild
 * the descriptor around that same id. So `refresh acme --token-url <other>`
 * loaded `tokens:acme` and POSTed the refresh token to `<other>` — no warning,
 * exit 0, and the response overwrote the stored tokens. Nothing exotic gets
 * there: a script or a copied command line that carries the login flags forward
 * with one host edited to a staging box, a proxy, or a typo.
 *
 * A flat refusal would be wrong, though — providers do move endpoints, so
 * changing a custom provider's token URL has to stay possible. What cannot stay
 * possible is doing it *by accident with the old credential in hand*, so the
 * deliberate path is `login`, which mints a fresh credential against the new
 * endpoints and re-remembers them (see `checkEndpoints` below). Every other
 * command that spends the credential is refused.
 *
 * A descriptor missing the URL under comparison is refused too. "No stored
 * endpoint" is not "no opinion": the check cannot be run, and the command would
 * still POST the stored credential to whatever the flag names — which is the
 * whole thing being prevented.
 */
function assertEndpointsMatch(
  providerId: string,
  remembered: ProviderConfig,
  supplied: ProviderConfig,
): void {
  for (const [field, flag] of COMPARED_ENDPOINTS) {
    const stored = remembered[field]
    const given = supplied[field]

    if (!given) {
      continue
    }

    if (!stored) {
      throw new CliError(
        `The descriptor stored for "${providerId}" records no ${field}, so ${flag} ${given} ` +
          'cannot be checked against the endpoint that issued the stored credential — and this ' +
          'command would send that credential to it.',
        `Drop the endpoint flags, or, to use these ones, sign in against them deliberately: ` +
          `ai-oauth-sdk login ${providerId} ${flag} ${given} …`,
      )
    }

    if (!sameEndpoint(stored, given)) {
      throw new CliError(
        `${flag} does not match the endpoint "${providerId}" was signed in against: ` +
          `stored ${stored}, given ${given}. The credential stored for "${providerId}" was ` +
          'issued by the first, and this command would send it to the second.',
        `Drop the endpoint flags to use the stored ones, or, if ${providerId} really has moved, ` +
          `sign in against the new endpoints deliberately: ai-oauth-sdk login ${providerId} ${flag} ${given} …`,
      )
    }
  }
}

/**
 * The descriptor a command runs against, for an id that is not a built-in.
 *
 * Endpoint flags win, as they always have — but only once they have been
 * checked against the descriptor remembered at login. Pass
 * `checkEndpoints: false` for a command that spends no stored credential at
 * either endpoint: `login`, which mints a new one against them, and `logout`,
 * which spends nothing at all.
 */
async function describeProvider(
  providerId: string,
  args: ParsedArgs,
  options: { checkEndpoints?: boolean } = {},
): Promise<ProviderConfig | undefined> {
  const supplied = customProvider(providerId, args)
  const remembered =
    providerId in providers ? undefined : await recallProvider(providerId, args)

  if (supplied && remembered && options.checkEndpoints !== false) {
    assertEndpointsMatch(providerId, remembered, supplied)
  }

  return supplied ?? remembered
}

/**
 * Resolves the client id for a command.
 *
 * The library requires this explicitly — no provider defaults to a vendor's
 * credential. A CLI is different: it *is* an application, so it can make that
 * choice once, here, on the user's behalf. `--client-id` always wins.
 */
function resolveClientId(providerId: string, args: ParsedArgs): string | undefined {
  return (
    flagString(args.flags, 'client-id') ??
    (publicClientIds as Record<string, string | undefined>)[providerId]
  )
}

/**
 * Builds a client from the shared flags every command accepts.
 *
 * The client secret is read from the environment as well as from a flag,
 * because the env var is the better channel — a flag is visible in `ps` and
 * lands in shell history. Falling back to a published secret follows the
 * client-id reasoning above: only Gemini ships one, its token endpoint refuses
 * the exchange without it, and an installed-app secret is non-confidential by
 * design. Either channel overrides it.
 */
async function clientFor(
  providerId: string,
  args: ParsedArgs,
  options: { checkEndpoints?: boolean } = {},
): Promise<AuthClient> {
  const clientId = resolveClientId(providerId, args)
  const clientSecret =
    flagString(args.flags, 'client-secret') ??
    process.env['AI_OAUTH_SDK_CLIENT_SECRET'] ??
    (publicClientSecrets as Record<string, string | undefined>)[providerId]
  const accountKey = flagString(args.flags, 'account')
  const authDir = flagString(args.flags, 'auth-dir')
  const scopes = flagString(args.flags, 'scopes')

  const custom = await describeProvider(providerId, args, options)

  try {
    return createNodeAuthClient({
      provider: custom ?? providerId,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(accountKey ? { accountKey } : {}),
      ...(authDir ? { authDir } : {}),
      ...(scopes ? { scopes: scopes.split(/[\s,]+/).filter(Boolean) } : {}),
    })
  } catch (error) {
    if (isOAuthError(error) && error.code === 'configuration_error') {
      throw new CliError(error.message, 'Pass --client-id=<id> (and --client-secret if required).')
    }

    if (isOAuthError(error) && error.code === 'unknown_provider') {
      throw new CliError(
        `Unknown provider "${providerId}".`,
        `Known: ${Object.keys(providers).join(', ')}. ` +
          'For anything else, pass --authorize-url and --token-url.',
      )
    }

    throw error
  }
}

/** Whether `--device` will work: RFC 8628, or a provider-supplied flow. */
function supportsDevice(provider: ProviderConfig): boolean {
  return Boolean(provider.deviceAuthorizationUrl || provider.deviceFlow)
}

/**
 * How to sign in, for the providers table. A provider with no redirect can only
 * do device; one with both is worth advertising as both, since the headless
 * option is the whole reason someone reads this column.
 */
function describeFlow(provider: ProviderConfig): string {
  if (provider.redirect.mode === 'custom') {
    return 'device'
  }

  if (supportsDevice(provider)) {
    return `${provider.redirect.mode} +device`
  }

  return provider.redirect.mode
}

function requireProvider(args: ParsedArgs, command: string): string {
  const providerId = args.positionals[0]

  if (!providerId) {
    throw new CliError(
      `Missing provider for "${command}".`,
      `Try: ai-oauth-sdk ${command} openai    (see: ai-oauth-sdk providers)`,
    )
  }

  return providerId
}

/**
 * Signs in, choosing the flow from the provider and the flags.
 *
 * A provider with no redirect can only be completed by device code, so it runs
 * one without `--device` being asked for: the alternative is a loopback server
 * that can never receive anything and a user waiting for a callback that is not
 * coming. That also makes `--paste` impossible for those providers, and the
 * combination is rejected here rather than in `pickReceiver`, which the
 * device-only path never reaches.
 *
 * This is the one command that may point an already-remembered custom provider
 * at different endpoints: it spends no stored credential, and the descriptor it
 * remembers below is the new one. That makes it the deliberate way to follow a
 * provider that has moved.
 */
export async function login({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'login')
  const client = await clientFor(providerId, args, { checkEndpoints: false })
  const provider = client.provider

  if (provider.experimental) {
    warn(`${provider.label} support is experimental — endpoints may change.`)
  }

  if (!(providerId in providers)) {
    await rememberProvider(provider, args)
  }

  const deviceOnly = provider.redirect.mode === 'custom' && supportsDevice(provider)

  const timeoutSeconds = flagNumber(args.flags, 'timeout')
  const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000

  if (deviceOnly && flagBoolean(args.flags, 'paste')) {
    throw new CliError(
      `${provider.label} has no redirect to paste back, so --paste cannot complete it.`,
      `Run: ai-oauth-sdk login ${provider.id} --device`,
    )
  }

  let tokens: TokenSet

  if (flagBoolean(args.flags, 'device') || deviceOnly) {
    tokens = await loginWithDevice(client, timeoutMs)
  } else {
    tokens = await client.login({
      receiver: pickReceiver(provider, args),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  }

  if (json) {
    outputJson(summarize(providerId, tokens, flagString(args.flags, 'account')))

    return
  }

  success(`Signed in to ${bold(provider.label)}${describeAccount(tokens)}`)
  info(dim(`  token expires in ${formatExpiry(tokens.expiresAt)}`))
  info(dim(`  stored in ${flagString(args.flags, 'auth-dir') ?? defaultAuthDir()}/auth.json`))
}

/** Renders the account suffix on the sign-in line, when the token identifies one. */
function describeAccount(tokens: TokenSet): string {
  if (tokens.email) {
    return ` as ${cyan(tokens.email)}`
  }

  if (tokens.accountId) {
    return ` (${tokens.accountId})`
  }

  return ''
}

/**
 * Chooses how the callback comes back.
 *
 * Under `--paste`, a provider with a hosted page, such as Claude, shows the code
 * itself, so pasting is the whole flow and there is nothing to listen for.
 * Everyone else redirects to a loopback port whose number we already know, so
 * the hybrid receiver listens on it and the callback lands without anything
 * being pasted whenever the browser is on this machine.
 *
 * Otherwise the URL is always printed, even though a browser is also being
 * opened: the launch fails silently over SSH, in containers and on minimal
 * desktops, and the printed link is then the only way forward. Only the
 * loopback receiver is wrapped to do that, because `defaultReceiver` already
 * announces in the headless branch it falls back to.
 */
function pickReceiver(provider: ProviderConfig, args: ParsedArgs) {
  const port = flagNumber(args.flags, 'port')

  if (flagBoolean(args.flags, 'paste')) {
    if (provider.redirect.mode === 'custom') {
      throw new CliError(
        `${provider.label} does not use a redirect, so --paste cannot complete it.`,
        `Run: ai-oauth-sdk login ${provider.id} --device`,
      )
    }

    if (provider.redirect.hostedUri) {
      return promptReceiver(
        port !== undefined ? { redirectUri: buildLoopbackRedirectUri(provider, port) } : {},
      )
    }

    return hybridReceiver({
      ...(port !== undefined ? { port } : {}),
      message: (url) =>
        `\nOpen this URL to sign in:\n\n  ${url}\n\n` +
        'Waiting for the redirect — if your browser is on another machine it will show\n' +
        '"This site can\'t be reached"; paste that URL here instead.\n',
    })
  }

  const announce = (url: string) => {
    info('')
    info(`  Opening ${cyan(url)}`)
    info(dim('  If your browser did not open, paste that URL into it.'))
    info('')
  }

  if (port !== undefined) {
    return loopbackReceiver({ port, onAuthorizationUrl: announce })
  }

  const receiver = defaultReceiver(provider)

  if (receiver.id === 'loopback') {
    return loopbackReceiver({ onAuthorizationUrl: announce })
  }

  return receiver
}

/**
 * Device-code login.
 *
 * `deviceLogin` takes a signal rather than a timeout, so `--timeout` is wired
 * through one here. Without it the flag is silently ignored and polling runs to
 * the provider's own expiry — typically fifteen minutes of a hung terminal.
 *
 * The core reports our own abort as `aborted`, which reads like the user
 * pressed ctrl-C, so `timedOut` records that the timer was what fired.
 *
 * A `devicePrerequisite` is printed before the code rather than after — one the
 * user reads only once the browser has already refused them is no help — and
 * again on failure, because a provider that rejects the *request* never reaches
 * `onCode` and would otherwise never show it at all.
 */
async function loginWithDevice(client: AuthClient, timeoutMs?: number): Promise<TokenSet> {
  const controller = timeoutMs === undefined ? undefined : new AbortController()
  let timedOut = false
  const timer =
    controller &&
    setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

  try {
    return await client.deviceLogin({
      ...(controller ? { signal: controller.signal } : {}),
      onCode: (device) => {
        info('')

        if (client.provider.devicePrerequisite) {
          warn(client.provider.devicePrerequisite)
          info('')
        }

        info(`  Open ${cyan(device.verificationUriComplete ?? device.verificationUri)}`)
        info(`  Enter code ${bold(device.userCode)}`)
        info('')
        info(dim('  Waiting for approval…'))
      },
    })
  } catch (error) {
    if (timedOut && isOAuthError(error) && error.code === 'aborted') {
      throw new CliError(
        `Timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s waiting for approval.`,
        'Approve the code sooner, or raise --timeout.',
      )
    }

    if (isOAuthError(error) && error.code === 'device_flow_failed' && client.provider.devicePrerequisite) {
      throw new CliError(error.message, client.provider.devicePrerequisite)
    }

    throw error
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function token({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'token')
  const client = await clientFor(providerId, args)

  try {
    const accessToken = await client.getAccessToken(
      flagBoolean(args.flags, 'force-refresh') ? { forceRefresh: true } : {},
    )

    if (json) {
      const tokens = await client.getTokens()
      outputJson({ provider: providerId, accessToken, expiresAt: tokens?.expiresAt ?? null })

      return
    }

    output(accessToken)
  } catch (error) {
    if (isOAuthError(error) && error.code === 'refresh_failed') {
      throw new CliError(error.message, `Run: ai-oauth-sdk login ${providerId}`)
    }

    throw error
  }
}

export async function whoami({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'whoami')
  const client = await clientFor(providerId, args)
  const tokens = await client.getTokens()

  if (!tokens) {
    throw new CliError(`Not signed in to ${providerId}.`, `Run: ai-oauth-sdk login ${providerId}`)
  }

  if (json) {
    outputJson(summarize(providerId, tokens, flagString(args.flags, 'account')))

    return
  }

  info(`${bold(client.provider.label)}`)
  info(`  account   ${tokens.email ?? tokens.accountId ?? dim('unknown')}`)
  info(`  expires   ${formatExpiry(tokens.expiresAt)}`)
  info(`  scopes    ${tokens.scope ?? dim('n/a')}`)
  info(`  refresh   ${tokens.refreshToken ? 'available' : dim('none')}`)
}

export async function list({ args, json }: CommandContext): Promise<void> {
  const authDir = flagString(args.flags, 'auth-dir')
  const storage = fileStorage(authDir ? { dir: authDir } : {})
  const sessions = await listStoredSessions(storage)

  if (sessions.length === 0) {
    if (json) {
      outputJson([])

      return
    }

    info(dim('No stored sessions.'))
    info(dim('Run: ai-oauth-sdk login openai'))

    return
  }

  const rows = await Promise.all(
    sessions.map(async (session) => {
      const raw = await storage.get(session.key)
      const tokens = raw ? (JSON.parse(raw) as TokenSet) : undefined

      return { session, tokens }
    }),
  )

  if (json) {
    outputJson(
      rows.map(({ session, tokens }) =>
        summarize(session.provider, tokens, session.accountKey),
      ),
    )

    return
  }

  table(
    ['PROVIDER', 'ACCOUNT', 'EXPIRES'],
    rows.map(({ session, tokens }) => [
      session.provider + (session.accountKey ? ` (${session.accountKey})` : ''),
      tokens?.email ?? tokens?.accountId ?? '—',
      formatExpiry(tokens?.expiresAt),
    ]),
  )
}

/**
 * Clears the stored tokens, and the descriptor that was saved alongside them.
 *
 * A custom provider's descriptor is written at login so later commands can
 * resolve the id. Once the tokens are gone it is orphaned, so it goes too —
 * otherwise `logout` leaves the credential file dirtier than it found it. Only
 * this account's descriptor, though: the others still describe live sessions.
 *
 * This is the one credential-spending-looking command exempt from the endpoint
 * check, because it spends nothing at either endpoint — `--revoke` talks to
 * `revocationUrl`, which is not among the compared flags. Refusing it would
 * only take away the command a user reaches for to clean up after a descriptor
 * that has gone wrong, and it is the command a script is most likely to run
 * with the whole flag set copied from `login`.
 *
 * `revoked` reports what the provider did, not what was asked for. It used to
 * be `--revoke` echoed back, which was wrong in both of the cases that matter:
 * most built-ins declare no revocation endpoint at all, and one that does can
 * answer 5xx — `AuthClient.logout` swallows that so the user is still signed
 * out locally. Either way the refresh token is still live at the provider,
 * while `revoked: true` told an offboarding script it was dead. The local
 * tokens are gone by then, so there is not even a credential left to retry
 * with; saying so on stderr is the least that is owed.
 */
export async function logout({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'logout')
  const client = await clientFor(providerId, args, { checkEndpoints: false })
  const shouldRevoke = flagBoolean(args.flags, 'revoke')

  if (shouldRevoke && !client.provider.revocationUrl) {
    warn(`${client.provider.label} has no revocation endpoint — clearing locally only.`)
  }

  const result = await client.logout(shouldRevoke ? { revoke: true } : {})

  if (result.revocation === 'failed') {
    warn(
      `${client.provider.label} refused the revocation — the token is still live there. ` +
        `(${result.revocationError?.message ?? 'unknown error'})`,
    )
  }

  if (!(providerId in providers)) {
    await storageFor(args).delete(descriptorKey(providerId, args))
  }

  if (json) {
    outputJson({
      provider: providerId,
      signedOut: result.signedOut,
      revoked: result.revocation === 'revoked',
      revocation: result.revocation,
      revocationError: result.revocationError
        ? { code: result.revocationError.code, message: result.revocationError.message }
        : null,
    })

    return
  }

  success(`Signed out of ${client.provider.label}.`)

  if (result.revocation === 'revoked') {
    info(dim('  token revoked at the provider'))
  } else if (shouldRevoke) {
    info(dim('  local tokens cleared; the token was not revoked at the provider'))
  }
}

export async function refresh({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'refresh')
  const client = await clientFor(providerId, args)

  try {
    const tokens = await client.refresh()

    if (json) {
      outputJson(summarize(providerId, tokens, flagString(args.flags, 'account')))

      return
    }

    success(`Refreshed ${client.provider.label} — expires in ${formatExpiry(tokens.expiresAt)}.`)
  } catch (error) {
    if (isOAuthError(error) && error.code === 'refresh_failed') {
      throw new CliError(error.message, `Run: ai-oauth-sdk login ${providerId}`)
    }

    throw error
  }
}

/** What a user has to supply before this provider can be used. */
function describeCredentials(id: string, provider: ProviderConfig): string {
  if (provider.requiresClientId === false) {
    return 'none needed'
  }

  if (id in publicClientIds) {
    return 'published id'
  }

  return 'bring your own'
}

export async function listProviders({ json }: CommandContext): Promise<void> {
  const entries = Object.entries(providers).map(([id, provider]) => {
    return {
      id,
      label: provider.label,
      flow: describeFlow(provider),
      credentials: describeCredentials(id, provider),
      experimental: Boolean(provider.experimental),
    }
  })

  if (json) {
    outputJson(entries)

    return
  }

  table(
    ['ID', 'PROVIDER', 'FLOW', 'CREDENTIALS'],
    entries.map((entry) => [
      entry.id,
      entry.label + (entry.experimental ? dim(' (experimental)') : ''),
      entry.flow,
      entry.credentials,
    ]),
  )
}

/** The signals a wrapped command realistically dies from. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
}

/**
 * Runs a command with the access token injected into its environment.
 *
 * Keeps the token off the process table and out of shell history, which
 * `--header "Authorization: Bearer $(ai-oauth-sdk token …)"` does not.
 *
 * A signalled child has a null exit code, so signals are reported the way a
 * shell reports them: `ai-oauth-sdk exec … ; echo $?` matches what running the
 * command directly would have given.
 */
export async function exec({ args }: CommandContext): Promise<number> {
  const providerId = requireProvider(args, 'exec')

  if (args.passthrough.length === 0) {
    throw new CliError(
      'No command to run.',
      'Put the command after --, e.g.: ai-oauth-sdk exec openai -- curl https://api.openai.com/v1/models',
    )
  }

  const client = await clientFor(providerId, args)
  const accessToken = await client.getAccessToken()
  const envVar = flagString(args.flags, 'env-var') ?? 'AI_OAUTH_SDK_TOKEN'

  const [command, ...commandArgs] = args.passthrough as [string, ...string[]]

  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      env: { ...process.env, [envVar]: accessToken, AI_OAUTH_SDK_PROVIDER: providerId },
    })

    child.on('error', (error) => {
      reject(
        new CliError(
          `Could not run "${command}": ${error.message}`,
          'Check the command exists and is on your PATH.',
        ),
      )
    })

    child.on('close', (code, signal) => {
      if (signal) {
        resolve(128 + (SIGNAL_NUMBERS[signal] ?? 0))

        return
      }

      resolve(code ?? 0)
    })
  })
}

function summarize(provider: string, tokens: TokenSet | undefined, accountKey?: string) {
  return {
    provider,
    ...(accountKey ? { account: accountKey } : {}),
    email: tokens?.email ?? null,
    accountId: tokens?.accountId ?? null,
    expiresAt: tokens?.expiresAt ?? null,
    expiresIn: formatExpiry(tokens?.expiresAt),
    scope: tokens?.scope ?? null,
    hasRefreshToken: Boolean(tokens?.refreshToken),
  }
}

export function resolveProviderOrThrow(id: string): ProviderConfig {
  try {
    return resolveProvider(id)
  } catch {
    throw new CliError(
      `Unknown provider "${id}".`,
      `Known: ${Object.keys(providers).join(', ')}`,
    )
  }
}
