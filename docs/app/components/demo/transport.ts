import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { streamText } from 'ai'

import type { DemoProvider } from '@/lib/demo-providers'
import type { Message } from './playground'

/**
 * Everything here runs in the page with the signed-in token. Nothing is proxied,
 * which is the point of the demo and also the reason only the providers that
 * allow a browser origin appear.
 */
function modelFor(provider: DemoProvider, accessToken: string, model: string) {
  if (provider.id === 'openrouter') {
    return createOpenRouter({ apiKey: accessToken })(model)
  }

  // An OAuth token is a bearer credential rather than an API key, so it goes in
  // the header the key would otherwise populate.
  return createGoogleGenerativeAI({
    apiKey: '',
    headers: { Authorization: `Bearer ${accessToken}` },
  })(model)
}

export async function* streamReply(
  provider: DemoProvider,
  accessToken: string,
  model: string,
  history: Message[],
) {
  const result = streamText({
    model: modelFor(provider, accessToken, model),
    messages: history.map((message) => ({ role: message.role, content: message.text })),
  })

  for await (const chunk of result.textStream) {
    yield chunk
  }
}

/**
 * What this account can actually reach, rather than a hardcoded list. The set
 * depends on the plan behind the token, so it is worth asking.
 */
export async function listModels(provider: DemoProvider, accessToken: string): Promise<string[]> {
  if (provider.id !== 'openrouter') {
    return provider.reachable?.models ?? []
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!response.ok) {
    throw new Error(`OpenRouter answered ${response.status} listing models`)
  }

  const body = (await response.json()) as { data?: { id?: string }[] }

  return (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id))
    .sort()
    .slice(0, 60)
}
