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
 * Two providers are deliberately absent:
 *
 * - **Google** requires an installed-app `clientSecret` as well. Google
 *   documents such secrets as non-confidential, but it is still a credential
 *   registered by someone else, so this library does not carry it. Register a
 *   "Desktop app" client in the Google Cloud console.
 * - **xAI** does not publish a client id at all.
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
} as const

export type PublicClientIdProvider = keyof typeof publicClientIds
