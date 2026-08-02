import { providerLogos } from '@/components/provider-logos'
import {
  ClaudeWordmark,
  GeminiWordmark,
  OpenAiWordmark,
  XaiWordmark,
} from '@/components/provider-wordmarks'

import type { DemoProvider } from '@/lib/demo-providers'
import type { ProviderLogoProps } from '@/components/provider-logos'
import type { ReactNode } from 'react'

/** The four that publish a lockup already carry their own name. */
const wordmarks: Record<string, (props: ProviderLogoProps) => ReactNode> = {
  openai: OpenAiWordmark,
  claude: ClaudeWordmark,
  gemini: GeminiWordmark,
  xai: XaiWordmark,
}

export function ProviderMark({ provider }: { provider: DemoProvider }) {
  const Wordmark = wordmarks[provider.id]
  const Logo = providerLogos[provider.id]

  return (
    <span className="flex min-w-0 items-center gap-2 text-lp-fg">
      {Wordmark ? (
        <Wordmark className={`w-auto ${heightClass(provider.logoHeight)}`} />
      ) : (
        Logo && <Logo className={`w-auto ${heightClass(provider.logoHeight)}`} />
      )}
      {provider.showName && <span className="truncate text-sm font-medium">{provider.name}</span>}
    </span>
  )
}

/** Tailwind needs the whole class name present to emit it, so map rather than interpolate. */
function heightClass(height: string) {
  const known: Record<string, string> = {
    '15px': 'h-[15px]',
    '16px': 'h-[16px]',
    '17px': 'h-[17px]',
    '20px': 'h-[20px]',
  }

  return known[height] ?? 'h-[16px]'
}
