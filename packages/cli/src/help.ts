import { providers } from '@ai-oauth-sdk/core'

import { bold, dim } from './output.js'

export function helpText(): string {
  return `${bold('ai-oauth-sdk')} — sign in to AI providers and get a token

${bold('USAGE')}
  ai-oauth-sdk <command> [provider] [options]

${bold('COMMANDS')}
  login <provider>      Sign in and store the token
  token <provider>      Print a valid access token (refreshes if needed)
  whoami <provider>     Show the signed-in account
  list, ls              List all stored sessions
  refresh <provider>    Force a token refresh
  logout <provider>     Forget the stored token
  providers             List supported providers
  exec <provider> -- …  Run a command with the token in its environment
  version               Print the installed version
  help                  Print this text

${bold('OPTIONS')}
  -v, --version         Print the installed version
  -h, --help            Print this text
  --json                Machine-readable output
  --account <name>      Use a named account slot (for multiple logins)
  --client-id <id>      Override the client id. Defaults to the one that
                        provider's own CLI publishes, where there is one.
  --client-secret <s>   Client secret, where the provider requires one. Prefer
                        AI_OAUTH_SDK_CLIENT_SECRET — a flag is visible in \`ps\`.
                        Never written to the credential file either way.
  --scopes "<a b c>"    Override the provider's default scopes
  --auth-dir <path>     Credential directory (default ~/.ai-oauth-sdk)

${bold('LOGIN OPTIONS')}
  --device              Use the device-code flow (no local browser needed)
  --paste               Print the URL and paste the result back
  --port <n>            Bind the loopback server to a specific port
  --timeout <seconds>   Give up waiting after N seconds

${bold('CUSTOM PROVIDERS')}
  --authorize-url <url> Use any OAuth 2.0 provider, not just the built-ins.
                        Needs an id of its own — a built-in id is refused.
  --token-url <url>     Required alongside --authorize-url
  --device-url <url>    Device authorization endpoint, if the provider has one

${bold('OTHER')}
  --force-refresh       (token) Refresh even if the current token is valid
  --revoke              (logout) Also revoke at the provider, where supported
  --env-var <NAME>      (exec) Env var to receive the token (default AI_OAUTH_SDK_TOKEN)

${bold('ENVIRONMENT')}
  AI_OAUTH_SDK_HOME           Credential directory (same as --auth-dir)
  AI_OAUTH_SDK_CLIENT_SECRET  Client secret, kept out of \`ps\` and shell history

${bold('PROVIDERS')}
  ${Object.keys(providers).join(', ')}

${bold('EXAMPLES')}
  ${dim('# Sign in, then use the token in a script')}
  ai-oauth-sdk login openai
  curl -H "Authorization: Bearer $(ai-oauth-sdk token openai)" \\
       https://api.openai.com/v1/models

  ${dim('# Keep the token out of shell history and the process table')}
  ai-oauth-sdk exec openai -- ./my-script.sh

  ${dim('# Headless box, no browser reachable')}
  ai-oauth-sdk login github-copilot --device

  ${dim('# Two accounts side by side')}
  ai-oauth-sdk login claude --account work
  ai-oauth-sdk token claude --account work

  ${dim('# Any OAuth 2.0 provider, not just the built-ins')}
  ai-oauth-sdk login acme --client-id my-client \\
    --authorize-url https://auth.acme.dev/authorize \\
    --token-url https://auth.acme.dev/token
`
}
