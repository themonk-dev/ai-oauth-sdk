import { spawn } from 'node:child_process'

import {
  buildLoopbackRedirectUri,
  defineProvider,
  isOAuthError,
  providers,
  publicClientIds,
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
 */
function customProvider(providerId: string, args: ParsedArgs): ProviderConfig | undefined {
  const authorizationUrl = flagString(args.flags, 'authorize-url')
  const tokenUrl = flagString(args.flags, 'token-url')
  if (!authorizationUrl && !tokenUrl) {
    return undefined
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
 * Remembers a custom provider's descriptor next to its tokens.
 *
 * Without this, `ai-oauth-sdk login acme --authorize-url … --token-url …` would
 * work but every later `token`/`refresh`/`whoami` would fail with
 * "unknown provider", since only the built-ins are resolvable by id.
 */
async function rememberProvider(provider: ProviderConfig, args: ParsedArgs): Promise<void> {
  // Never persist the secret. It arrives as a flag, so it is already in the
  // process table and the shell history; writing it to the credential file as
  // well would make a transient exposure a durable one. Later commands re-read
  // it from --client-secret or AI_OAUTH_SDK_CLIENT_SECRET.
  const { clientSecret: _omitted, ...withoutSecret } = provider
  await storageFor(args).set(PROVIDER_KEY_PREFIX + provider.id, JSON.stringify(withoutSecret))
}

async function recallProvider(
  providerId: string,
  args: ParsedArgs,
): Promise<ProviderConfig | undefined> {
  const stored = await storageFor(args).get(PROVIDER_KEY_PREFIX + providerId)
  if (!stored) {
    return undefined
  }
  try {
    return JSON.parse(stored) as ProviderConfig
  } catch {
    return undefined
  }
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

/** Builds a client from the shared flags every command accepts. */
async function clientFor(providerId: string, args: ParsedArgs): Promise<AuthClient> {
  const clientId = resolveClientId(providerId, args)
  // The env var is the better channel — a flag is visible in `ps` and lands in
  // shell history — so it is supported alongside the flag rather than instead.
  const clientSecret =
    flagString(args.flags, 'client-secret') ?? process.env['AI_OAUTH_SDK_CLIENT_SECRET']
  const accountKey = flagString(args.flags, 'account')
  const authDir = flagString(args.flags, 'auth-dir')
  const scopes = flagString(args.flags, 'scopes')

  // Explicit flags win; otherwise fall back to a descriptor saved at login time.
  const custom =
    customProvider(providerId, args) ??
    (providerId in providers ? undefined : await recallProvider(providerId, args))

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


export async function login({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'login')
  const client = await clientFor(providerId, args)
  const provider = client.provider

  if (provider.experimental) {
    warn(`${provider.label} support is experimental — endpoints may change.`)
  }

  // Save non-built-in descriptors so later commands can resolve this id.
  if (!(providerId in providers)) {
    await rememberProvider(provider, args)
  }

  // A provider with no redirect can only be completed by device code. Requiring
  // `--device` for those means the default lands on a loopback server that can
  // never receive anything, and the user waits for a callback that is not coming.
  const deviceOnly = provider.redirect.mode === 'custom' && Boolean(provider.deviceAuthorizationUrl)

  const timeoutSeconds = flagNumber(args.flags, 'timeout')
  const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000

  const tokens = flagBoolean(args.flags, 'device') || deviceOnly
    ? await loginWithDevice(client, timeoutMs)
    : await client.login({
        receiver: pickReceiver(provider, args),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })

  if (json) {
    outputJson(summarize(providerId, tokens, flagString(args.flags, 'account')))
    return
  }
  success(
    `Signed in to ${bold(provider.label)}` +
      (tokens.email ? ` as ${cyan(tokens.email)}` : tokens.accountId ? ` (${tokens.accountId})` : ''),
  )
  info(dim(`  token expires in ${formatExpiry(tokens.expiresAt)}`))
  info(dim(`  stored in ${flagString(args.flags, 'auth-dir') ?? defaultAuthDir()}/auth.json`))
}

function pickReceiver(provider: ProviderConfig, args: ParsedArgs) {
  if (flagBoolean(args.flags, 'paste')) {
    if (provider.redirect.mode === 'custom') {
      throw new CliError(
        `${provider.label} does not use a redirect, so --paste cannot complete it.`,
        `Run: ai-oauth-sdk login ${provider.id} --device`,
      )
    }
    // A specific port still has to appear in the redirect URI, because the
    // provider matches it against the one sent at the token exchange.
    const port = flagNumber(args.flags, 'port')
    return promptReceiver(
      port !== undefined ? { redirectUri: buildLoopbackRedirectUri(provider, port) } : {},
    )
  }

  // Always show the URL, even when a browser is being opened: if the launch
  // silently fails — common over SSH, in containers, and on minimal desktops —
  // the printed link is the only way forward.
  const announce = (url: string) => {
    info('')
    info(`  Opening ${cyan(url)}`)
    info(dim('  If your browser did not open, paste that URL into it.'))
    info('')
  }

  const port = flagNumber(args.flags, 'port')
  if (port !== undefined) {
    return loopbackReceiver({ port, onAuthorizationUrl: announce })
  }

  const receiver = defaultReceiver(provider)
  // defaultReceiver already announces in its headless branch; wrap the others.
  return receiver.id === 'loopback'
    ? loopbackReceiver({ onAuthorizationUrl: announce })
    : receiver
}

/**
 * Device-code login.
 *
 * `deviceLogin` takes a signal rather than a timeout, so `--timeout` is wired
 * through one here. Without it the flag is silently ignored and polling runs to
 * the provider's own expiry — typically fifteen minutes of a hung terminal.
 */
async function loginWithDevice(client: AuthClient, timeoutMs?: number): Promise<TokenSet> {
  const controller = timeoutMs === undefined ? undefined : new AbortController()
  const timer = controller && setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await client.deviceLogin({
      ...(controller ? { signal: controller.signal } : {}),
      onCode: (device) => {
        info('')
        info(`  Open ${cyan(device.verificationUriComplete ?? device.verificationUri)}`)
        info(`  Enter code ${bold(device.userCode)}`)
        info('')
        info(dim('  Waiting for approval…'))
      },
    })
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
    // Bare token on stdout — this is the whole point of the command.
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

export async function logout({ args, json }: CommandContext): Promise<void> {
  const providerId = requireProvider(args, 'logout')
  const client = await clientFor(providerId, args)
  const shouldRevoke = flagBoolean(args.flags, 'revoke')

  if (shouldRevoke && !client.provider.revocationUrl) {
    warn(`${client.provider.label} has no revocation endpoint — clearing locally only.`)
  }

  await client.logout(shouldRevoke ? { revoke: true } : {})

  // A custom provider's descriptor was saved at login so later commands could
  // resolve it. With the tokens gone it is orphaned, so forget it too —
  // otherwise `logout` leaves the credential file dirtier than it found it.
  if (!(providerId in providers) && !flagString(args.flags, 'account')) {
    await storageFor(args).delete(PROVIDER_KEY_PREFIX + providerId)
  }

  if (json) {
    outputJson({ provider: providerId, signedOut: true, revoked: shouldRevoke })
    return
  }
  success(`Signed out of ${client.provider.label}.`)
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

export async function listProviders({ json }: CommandContext): Promise<void> {
  const entries = Object.entries(providers).map(([id, provider]) => {
    // The CLI opts into a published id where one exists; otherwise you supply one.
    const published = id in publicClientIds
    return {
      id,
      label: provider.label,
      flow: provider.redirect.mode === 'custom' ? 'device' : provider.redirect.mode,
      credentials:
        provider.requiresClientId === false
          ? 'none needed'
          : published
            ? 'published id'
            : 'bring your own',
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
      // A signalled child has a null exit code. Report it the way a shell does,
      // so `ai-oauth-sdk exec … ; echo $?` matches running the command directly.
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
