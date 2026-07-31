/**
 * Client ids published by the vendors' own CLIs, for you to opt into.
 *
 * No provider defaults to one of these. Like Passport, you name the credential
 * at initialization:
 *
 * ```ts
 * import { createAuthClient, publicClientIds } from '@ai-oauth-sdk/core'
 *
 * // Present as that vendor's CLI…
 * createAuthClient({ provider: 'openai', clientId: publicClientIds.openai })
 *
 * // …or as yourself.
 * createAuthClient({ provider: 'openai', clientId: 'my-registered-client' })
 * ```
 *
 * These are not secrets. They are public, PKCE-only clients extracted from
 * binaries the vendors distribute, and OAuth is designed so that publishing them
 * is safe. But **using one means presenting your application as that CLI**,
 * which is a decision only you can make — hence the explicit argument. Check the
 * provider's terms before shipping it in a product, and register your own client
 * wherever one is on offer.
 *
 * **Google is the odd one out**: its installed-app clients carry a
 * `clientSecret` as well, published alongside the id in {@link
 * publicClientSecrets}.
 */
export const publicClientIds = {
  /** OpenAI's Codex CLI. */
  openai: 'app_EMoamEEZ73f0CkXaXp7hrann',
  /** Anthropic's Claude Code. */
  anthropic: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  /** The VS Code Copilot extension and GitHub's Copilot CLI. */
  'github-copilot': 'Iv1.b507a08c87ecfe98',
  /** Alibaba's qwen-code. */
  qwen: 'f0304373b74a44d2b584a3fb70ca9e56',
  /** Google's gemini-cli. Pair with {@link publicClientSecrets.google}. */
  google: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  /**
   * xAI's grok-cli.
   *
   * Unlike the others this is not merely convenient — xAI rejects any client it
   * has not allowlisted (`invalid_client`, "Unknown or disabled client"), and
   * offers no self-service registration for a desktop CLI, so there is no
   * alternative id to supply.
   */
  xai: 'b1a00492-073a-47ea-816f-4c329264a828',
} as const

/**
 * Client secrets for the public clients that ship with one.
 *
 * Only Google. OAuth for installed applications treats these as non-secret —
 * they ship inside a binary anyone can read, and Google
 * [documents them as such](https://developers.google.com/identity/protocols/oauth2/native-app).
 * PKCE, not the secret, is what protects the flow, and Google's token endpoint
 * simply refuses the exchange without one.
 *
 * ```ts
 * createAuthClient({
 *   provider: 'google',
 *   clientId: publicClientIds.google,
 *   clientSecret: publicClientSecrets.google,
 * })
 * ```
 *
 * Because it is published in a repository, automated secret scanning may report
 * this value to Google and get it rotated. That breaks nothing structurally —
 * pass `clientSecret` explicitly, set `AI_OAUTH_SDK_CLIENT_SECRET`, or use
 * `--client-secret` — but if `login google` starts failing with
 * `invalid_client`, a rotation is the first thing to check. Registering your own
 * "Desktop app" client in the Google Cloud console avoids the question entirely.
 */
export const publicClientSecrets = {
  /** Google's gemini-cli, paired with {@link publicClientIds.google}. */
  google: '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',
} as const

export type PublicClientIdProvider = keyof typeof publicClientIds
