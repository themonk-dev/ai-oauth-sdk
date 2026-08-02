import { Link } from 'react-router'

import {
  AzureAiLogo,
  GitHubCopilotLogo,
  OpenRouterLogo,
  QwenLogo,
  type ProviderLogoProps,
} from './provider-logos'
import {
  ClaudeWordmark,
  GeminiWordmark,
  OpenAiWordmark,
  XaiWordmark,
} from './provider-wordmarks'

import type { ReactNode } from 'react'

interface Brand {
  id: string
  name: string
  mark: ReactNode
}

/**
 * Four providers publish a wordmark that already says their name. The rest ship
 * a mark alone, so those get the mark and the name set beside it.
 */
function wordmark(Component: (props: ProviderLogoProps) => ReactNode, height: string) {
  return <Component className={`${height} w-auto`} />
}

function markAndName(
  Component: (props: ProviderLogoProps) => ReactNode,
  height: string,
  name: string,
) {
  return (
    <>
      <Component className={`${height} w-auto`} />
      <span className="text-[15px] font-medium">{name}</span>
    </>
  )
}

const brands: Brand[] = [
  { id: 'openai', name: 'OpenAI', mark: wordmark(OpenAiWordmark, 'h-[18px]') },
  { id: 'claude', name: 'Claude', mark: wordmark(ClaudeWordmark, 'h-[17px]') },
  { id: 'gemini', name: 'Gemini', mark: wordmark(GeminiWordmark, 'h-[20px]') },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    mark: markAndName(GitHubCopilotLogo, 'h-[22px]', 'Copilot'),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    mark: markAndName(OpenRouterLogo, 'h-[20px]', 'OpenRouter'),
  },
  { id: 'xai', name: 'Grok', mark: wordmark(XaiWordmark, 'h-[26px]') },
  { id: 'qwen', name: 'Qwen', mark: markAndName(QwenLogo, 'h-[21px]', 'Qwen') },
  { id: 'azure-ai', name: 'Azure AI', mark: markAndName(AzureAiLogo, 'h-[21px]', 'Azure AI') },
]

/**
 * The grid draws its own rules with a 1px gap over a tinted background, so the
 * cells share a hairline instead of each carrying a border that doubles up.
 *
 * `tone` picks the palette, because this renders both inside the docs and on
 * the landing page, and those two do not share a set of colours.
 */
const tones = {
  docs: { rule: 'bg-fd-border', cell: 'bg-fd-background text-fd-foreground hover:bg-fd-accent' },
  landing: { rule: 'bg-lp-line', cell: 'bg-lp-bg text-lp-fg hover:bg-lp-hover' },
}

export function ProviderGrid({
  className,
  tone = 'docs',
}: {
  className?: string
  tone?: keyof typeof tones
}) {
  return (
    <div
      className={`not-prose grid grid-cols-2 gap-px sm:grid-cols-4 ${tones[tone].rule} ${className ?? ''}`}
    >
      {brands.map((brand) => (
        <Link
          key={brand.id}
          to={`/docs/providers/${brand.id}`}
          title={brand.name}
          className={`flex h-[92px] items-center justify-center gap-2.5 transition-colors ${tones[tone].cell}`}
        >
          {brand.mark}
        </Link>
      ))}
    </div>
  )
}
