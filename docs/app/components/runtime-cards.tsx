import {
  RiCloudLine,
  RiGlobeLine,
  RiLayoutGridLine,
  RiNodejsLine,
  RiSmartphoneLine,
  RiTerminalBoxLine,
} from '@remixicon/react'
import { Link } from 'react-router'

import type { ReactNode } from 'react'

interface Runtime {
  title: string
  install: string
  description: string
  href: string
  icon: ReactNode
}

const runtimes: Runtime[] = [
  {
    title: 'Terminal',
    install: '@ai-oauth-sdk/cli',
    description: 'Sign in once, then print a token into a subshell or a script environment.',
    href: '/runtimes/cli',
    icon: <RiTerminalBoxLine className="size-5" />,
  },
  {
    title: 'Node, Bun, Deno',
    install: '@ai-oauth-sdk/node',
    description: 'Loopback server, file-backed storage at 0600, and a browser launcher.',
    href: '/runtimes/node',
    icon: <RiNodejsLine className="size-5" />,
  },
  {
    title: 'Browser',
    install: '@ai-oauth-sdk/browser',
    description: 'Popup and full-page redirect receivers, with session or local storage.',
    href: '/runtimes/browser',
    icon: <RiGlobeLine className="size-5" />,
  },
  {
    title: 'React, Vue, Svelte, Solid',
    install: '@ai-oauth-sdk/react',
    description: 'One observable store, four idiomatic bindings over it.',
    href: '/frameworks',
    icon: <RiLayoutGridLine className="size-5" />,
  },
  {
    title: 'React Native, Expo',
    install: '@ai-oauth-sdk/react-native',
    description: 'Deep link or auth session, SecureStore for tokens, and no polyfills.',
    href: '/runtimes/react-native',
    icon: <RiSmartphoneLine className="size-5" />,
  },
  {
    title: 'Script tag',
    install: 'ai-oauth-sdk',
    description: 'A self-contained bundle on window.AIOAuth, with no build step.',
    href: '/runtimes/cdn',
    icon: <RiCloudLine className="size-5" />,
  },
]

export function RuntimeCards() {
  return (
    <div className="not-prose grid grid-cols-1 gap-3 sm:grid-cols-2">
      {runtimes.map((runtime) => (
        <Link
          key={runtime.href}
          to={runtime.href}
          className="group flex flex-col gap-2.5 rounded-xl border border-fd-border bg-fd-card p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-fd-primary/40 hover:shadow-md"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-fd-primary/10 p-2 text-fd-primary transition-colors duration-200 group-hover:bg-fd-primary/20">
              {runtime.icon}
            </div>
            <h3 className="text-sm font-semibold tracking-tight text-fd-foreground">
              {runtime.title}
            </h3>
          </div>

          <p className="text-[13px] leading-relaxed text-fd-muted-foreground">
            {runtime.description}
          </p>

          <code className="w-fit rounded-md bg-fd-muted px-2 py-1 font-mono text-[11px] text-fd-muted-foreground">
            {runtime.install}
          </code>
        </Link>
      ))}
    </div>
  )
}
