import {
  ArrowRight,
  ChevronDown,
  Clipboard,
  Database,
  Globe,
  KeyRound,
  Package,
  Puzzle,
  Radio,
  RefreshCw,
  Repeat,
  Server,
  Shield,
  Terminal,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import type { ReactNode } from 'react'

interface Feature {
  title: string
  description: string
  href: string
  icon: ReactNode
}

const features: Feature[] = [
  {
    title: 'Zero dependencies',
    description: 'The core ships no runtime dependencies at all, and runs on any JavaScript runtime with fetch.',
    href: '/overview',
    icon: <Package className="size-5" />,
  },
  {
    title: 'PKCE and state, enforced',
    description: 'S256 everywhere it applies, constant-time state comparison, and no Math.random fallback.',
    href: '/resources/security',
    icon: <Shield className="size-5" />,
  },
  {
    title: 'Loopback callback',
    description: 'A one-shot HTTP server on 127.0.0.1 catches the redirect, the way RFC 8252 intends.',
    href: '/flows/loopback',
    icon: <Server className="size-5" />,
  },
  {
    title: 'Popup and redirect',
    description: 'Two browser receivers, so a single-page app can sign in without leaving the tab or by leaving it.',
    href: '/flows/popup-and-redirect',
    icon: <Globe className="size-5" />,
  },
  {
    title: 'Device code',
    description: 'RFC 8628 for machines with no reachable browser, plus the providers that bend it.',
    href: '/flows/device-code',
    icon: <Radio className="size-5" />,
  },
  {
    title: 'Start here, finish there',
    description: 'Begin a flow in one request and collect the token in another, correlated by state.',
    href: '/flows/state-handoff',
    icon: <Repeat className="size-5" />,
  },
  {
    title: 'Refresh that behaves',
    description: 'Concurrent callers share one refresh, and a token rotated by another process is picked up.',
    href: '/reference/tokens',
    icon: <RefreshCw className="size-5" />,
  },
  {
    title: 'Storage you control',
    description: 'Three methods and an optional fourth. File, localStorage, SecureStore, Redis, or your own table.',
    href: '/reference/storage',
    icon: <Database className="size-5" />,
  },
  {
    title: 'One store, four bindings',
    description: 'React, Vue, Svelte and Solid are thin adapters over the same state machine.',
    href: '/frameworks',
    icon: <Puzzle className="size-5" />,
  },
  {
    title: 'Any OAuth 2.0 provider',
    description: 'Describe one with defineProvider, or build it from an OIDC discovery document at runtime.',
    href: '/providers/custom',
    icon: <KeyRound className="size-5" />,
  },
  {
    title: 'A CLI that scripts',
    description: 'Print a token for a subshell, or run a command with the token in its environment.',
    href: '/runtimes/cli',
    icon: <Terminal className="size-5" />,
  },
  {
    title: 'Paste the code',
    description: 'For SSH sessions and headless boxes where a loopback redirect could never arrive.',
    href: '/flows/manual-paste',
    icon: <Clipboard className="size-5" />,
  },
]

const INITIAL_COUNT = 6

export function FeatureCards() {
  const [expanded, setExpanded] = useState(false)

  const visible = expanded ? features : features.slice(0, INITIAL_COUNT)
  const remaining = features.length - INITIAL_COUNT

  return (
    <div className="not-prose">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((feature) => (
          <Link
            key={feature.href}
            to={feature.href}
            className="group relative flex flex-col gap-3 rounded-xl border border-fd-border bg-fd-card p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-fd-primary/40"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-fd-primary/10 p-2 text-fd-primary transition-colors duration-200 group-hover:bg-fd-primary/20">
                  {feature.icon}
                </div>
                <h3 className="text-sm font-semibold tracking-tight text-fd-foreground">
                  {feature.title}
                </h3>
              </div>
              <ArrowRight className="size-4 -translate-x-1 text-fd-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-hover:text-fd-primary" />
            </div>
            <p className="text-[13px] leading-relaxed text-fd-muted-foreground">
              {feature.description}
            </p>
          </Link>
        ))}
      </div>
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-fd-border bg-fd-card px-4 py-2.5 text-sm font-medium text-fd-muted-foreground transition-colors duration-200 hover:bg-fd-accent hover:text-fd-foreground"
        >
          Show {remaining} more features
          <ChevronDown className="size-4" />
        </button>
      )}
    </div>
  )
}
