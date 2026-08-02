import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { lazy, Suspense } from 'react'

import { baseOptions } from '@/lib/layout.shared'
import { pageMeta } from '@/lib/seo'
import { appName } from '@/lib/shared'

import type { ReactNode } from 'react'

// The playground pulls in the AI SDK and reaches for `window` on mount, so it
// stays out of the prerendered HTML and loads once the page is interactive.
const Playground = lazy(() =>
  import('@/components/demo/playground').then((module) => ({ default: module.Playground })),
)

export function meta() {
  return pageMeta({
    title: `Playground | ${appName}`,
    description:
      'Sign in to a provider in the browser and chat with it. No backend, no proxy, and the token never leaves the tab.',
    path: '/demo',
  })
}

function Band({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="grid grid-cols-[1fr_minmax(0,1100px)_1fr] border-b border-lp-line">
      <div className="hatched" />
      <div className={`border-x border-lp-line ${className ?? ''}`}>{children}</div>
      <div className="hatched" />
    </div>
  )
}

export default function Demo() {
  return (
    <HomeLayout {...baseOptions()} nav={{ ...baseOptions().nav, url: '/' }}>
      <div className="w-full bg-lp-bg font-landing tracking-normal text-lp-fg">
        <Band className="px-6 py-16 sm:px-14">
          <div className="font-mono text-xs tracking-[0.04em] text-lp-dim uppercase">
            Playground
          </div>
          <h1 className="mt-6 max-w-[820px] text-4xl leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[46px]">
            One thread. Swap the provider under it.
          </h1>
          <p className="mt-5 max-w-[640px] text-lg leading-[1.65] text-lp-muted">
            Pick a provider from the header and the conversation carries over. Signing in happens in
            a popup, the token stays in this tab, and the reply streams straight from the provider.
            Nothing here talks to a server of ours.
          </p>
        </Band>

        <Band className="px-6 py-10 sm:px-14">
          <Suspense
            fallback={
              <div className="h-[520px] animate-pulse rounded-xl border border-lp-line bg-lp-surface" />
            }
          >
            <Playground />
          </Suspense>
        </Band>

        <Band className="px-6 py-10 sm:px-14">
          <h2 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
            Why some providers are greyed out
          </h2>
          <p className="mt-4 max-w-[720px] text-base leading-[1.65] text-lp-muted">
            A sign-in from a page needs the provider's token endpoint to allow this origin, and a
            reply needs the same of its API. Providers built for desktop CLIs mostly send no CORS
            headers at all, and no client library can add them. Those flows work perfectly from the
            CLI or a server, which is what the{' '}
            <a href="/docs/recipes/server-callback" className="underline underline-offset-4">
              server callback recipe
            </a>{' '}
            is for. The{' '}
            <a href="/docs/runtimes/browser#cors" className="underline underline-offset-4">
              browser runtime page
            </a>{' '}
            covers the rule in full.
          </p>
        </Band>
      </div>
    </HomeLayout>
  )
}
