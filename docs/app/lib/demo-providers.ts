import { ProviderId } from '@ai-oauth-sdk/browser'

/**
 * What the playground can and cannot do from a page.
 *
 * A browser sign-in needs the provider's *token* endpoint to allow the origin,
 * and a browser chat needs the same of its API. Providers built for desktop CLIs
 * mostly send no CORS headers at all, and no client library can add them, which
 * is the limitation the browser runtime page describes. Measured per provider
 * rather than assumed, because the answer is not guessable from the docs.
 */
export interface DemoProvider {
  id: string
  name: string
  /** The wordmark already says the name for some of these. */
  showName: boolean
  logoHeight: string
  /** Absent when the browser cannot complete the flow. */
  reachable?: {
    /** Passed to `useAuth`. OpenRouter identifies the app by its callback URL. */
    requiresClientId: boolean
    models: string[]
  }
  /** Why not, in one line, for the ones that need a server. */
  blockedBy?: string
}

export const demoProviders: DemoProvider[] = [
  {
    id: ProviderId.OpenRouter,
    name: 'OpenRouter',
    showName: true,
    logoHeight: '16px',
    reachable: { requiresClientId: false, models: [] },
  },
  {
    id: ProviderId.Gemini,
    name: 'Gemini',
    showName: false,
    logoHeight: '17px',
    reachable: { requiresClientId: true, models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  },
  {
    id: ProviderId.OpenAI,
    name: 'OpenAI',
    showName: false,
    logoHeight: '15px',
    blockedBy: 'The Codex endpoint sends no CORS headers, so a page cannot call it.',
  },
  {
    id: ProviderId.Claude,
    name: 'Claude',
    showName: false,
    logoHeight: '15px',
    blockedBy: 'Neither the token endpoint nor the Messages API allows a browser origin.',
  },
  {
    id: ProviderId.GitHubCopilot,
    name: 'Copilot',
    showName: true,
    logoHeight: '17px',
    blockedBy: 'The device-code token endpoint sends no CORS headers.',
  },
  {
    id: ProviderId.Grok,
    name: 'Grok',
    showName: false,
    logoHeight: '20px',
    blockedBy: 'Built for a desktop CLI, with no browser origin allowed.',
  },
  {
    id: ProviderId.Qwen,
    name: 'Qwen',
    showName: true,
    logoHeight: '17px',
    blockedBy: 'Device-code only, and the token endpoint rejects a browser origin.',
  },
  {
    id: 'azure-ai',
    name: 'Azure AI',
    showName: true,
    logoHeight: '17px',
    blockedBy: 'Endpoints are tenant-scoped, so there is nothing generic to sign in to.',
  },
]

export const reachableCount = demoProviders.filter((entry) => entry.reachable).length
