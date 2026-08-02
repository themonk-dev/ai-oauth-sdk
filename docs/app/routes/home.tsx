import { RiArrowRightLine, RiCheckLine, RiFileCopyLine } from '@remixicon/react'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { useState } from 'react'
import { Link } from 'react-router'

import { CodeShowcase } from '@/components/code-showcase'
import { ProviderGrid } from '@/components/provider-grid'
import { baseOptions } from '@/lib/layout.shared'
import { appName, githubUrl } from '@/lib/shared'

import type { ReactNode } from 'react'

const INSTALL = 'npm i ai-oauth-sdk'

const features = [
  {
    title: 'Zero dependencies',
    body: 'The core ships no runtime dependencies at all, and runs on any JavaScript runtime with fetch.',
  },
  {
    title: 'PKCE and state, enforced',
    body: 'S256 everywhere it applies, constant-time state comparison, and no Math.random fallback.',
  },
  {
    title: 'Loopback callback',
    body: 'A one-shot HTTP server on 127.0.0.1 catches the redirect, the way RFC 8252 intends.',
  },
  {
    title: 'Popup and redirect',
    body: 'Two browser receivers, so a single-page app can sign in without leaving the tab, or by leaving it.',
  },
  {
    title: 'Device code',
    body: 'RFC 8628 for machines with no reachable browser, plus the providers that bend it.',
  },
  {
    title: 'Start here, finish there',
    body: 'Begin a flow in one request and collect the token in another, correlated by state.',
  },
]

const runtimes = [
  {
    title: 'Terminal',
    body: 'Sign in once, then print a token into a subshell or a script.',
    pkg: '@ai-oauth-sdk/cli',
    href: '/docs/runtimes/cli',
  },
  {
    title: 'Node, Bun, Deno',
    body: 'Loopback server, file-backed storage at 0600, browser launcher.',
    pkg: '@ai-oauth-sdk/node',
    href: '/docs/runtimes/node',
  },
  {
    title: 'Browser',
    body: 'Popup and full-page redirect receivers, session or local storage.',
    pkg: '@ai-oauth-sdk/browser',
    href: '/docs/runtimes/browser',
  },
  {
    title: 'React, Vue, Svelte, Solid',
    body: 'One observable store, four idiomatic bindings over it.',
    pkg: '@ai-oauth-sdk/react',
    href: '/docs/frameworks',
  },
  {
    title: 'React Native, Expo',
    body: 'Deep link or auth session, SecureStore for tokens, no polyfills.',
    pkg: '@ai-oauth-sdk/react-native',
    href: '/docs/runtimes/react-native',
  },
  {
    title: 'Script tag',
    body: 'A self-contained bundle on window.AIOAuth, with no build step.',
    pkg: 'ai-oauth-sdk',
    href: '/docs/runtimes/cdn',
  },
]

const footerLinks = [
  {
    heading: 'Docs',
    items: [
      { label: 'Introduction', href: '/docs' },
      { label: 'Quickstart', href: '/docs/quick-start' },
      { label: 'Overview', href: '/docs/overview' },
    ],
  },
  {
    heading: 'Reference',
    items: [
      { label: 'Runtimes', href: '/docs/runtimes' },
      { label: 'Providers', href: '/docs/providers' },
      { label: 'Flows', href: '/docs/flows' },
    ],
  },
  {
    heading: 'Source',
    items: [
      { label: 'GitHub', href: githubUrl, external: true },
      { label: 'npm', href: 'https://www.npmjs.com/package/ai-oauth-sdk', external: true },
      { label: 'Disclaimer', href: '/docs/resources/disclaimer' },
    ],
  },
]

export function meta() {
  return [
    { title: `${appName} · sign in with any AI provider` },
    {
      name: 'description',
      content:
        'Provider-agnostic OAuth 2.0 for AI CLIs and apps. Redirect the user, receive the callback, get a token back.',
    },
  ]
}

/**
 * The nav links the docs layout does not carry, since the sidebar covers them
 * everywhere else. The call to action is a custom item rather than Fumadocs'
 * button, which would paint itself in the docs theme's primary and put the one
 * accent hue on an otherwise monochrome page.
 */
function landingOptions() {
  const base = baseOptions()

  return {
    ...base,
    nav: { ...base.nav, url: '/' },
    links: [
      { text: 'Documentation', url: '/docs', active: 'none' as const },
      { text: 'Providers', url: '/docs/providers', active: 'none' as const },
      { text: 'Runtimes', url: '/docs/runtimes', active: 'none' as const },
      { text: 'Security', url: '/docs/resources/security', active: 'none' as const },
      ...(base.links ?? []),
      {
        type: 'custom' as const,
        secondary: true,
        children: (
          <Link
            to="/docs"
            className="inline-flex h-[34px] items-center rounded-lg bg-lp-button px-4 text-sm font-medium text-lp-button-fg transition-colors hover:bg-lp-button-hover"
          >
            Read the docs
          </Link>
        ),
      },
    ],
  }
}

/**
 * Content sits in a fixed-width column with the leftover margin hatched, which
 * is where the docs-framework look comes from. The rules are on the column, so
 * they meet the section borders at the same two x positions all the way down.
 */
function Band({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="grid grid-cols-[1fr_minmax(0,1100px)_1fr] border-b border-lp-line">
      <div className="hatched" />
      <div className={`border-x border-lp-line ${className ?? ''}`}>{children}</div>
      <div className="hatched" />
    </div>
  )
}

/** The corner ticks that mark where a band's rules cross its borders. */
function CornerTicks({ bottom = true }: { bottom?: boolean }) {
  const tick = 'absolute font-mono text-[13px] leading-none text-lp-tick select-none'

  return (
    <>
      <span className={`${tick} -top-1.5 -left-1.5`}>+</span>
      <span className={`${tick} -top-1.5 -right-1.5`}>+</span>
      {bottom && (
        <>
          <span className={`${tick} -bottom-1.5 -left-1.5`}>+</span>
          <span className={`${tick} -bottom-1.5 -right-1.5`}>+</span>
        </>
      )}
    </>
  )
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-xs tracking-[0.04em] text-lp-dim uppercase">
      {children}
    </div>
  )
}

function PrimaryLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex h-[46px] items-center gap-2 rounded-lg bg-lp-button px-6 text-[15px] font-medium text-lp-button-fg transition-colors hover:bg-lp-button-hover"
    >
      {children}
      <RiArrowRightLine className="size-4" />
    </Link>
  )
}

function SecondaryLink({
  to,
  external,
  children,
}: {
  to: string
  external?: boolean
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className="inline-flex h-[46px] items-center rounded-lg border border-lp-line px-6 text-[15px] font-medium transition-colors hover:bg-lp-hover"
    >
      {children}
    </Link>
  )
}

function InstallCommand() {
  const [copied, setCopied] = useState(false)

  // Not available over plain HTTP, and Firefox withholds it without a prompt.
  const copy = () => {
    navigator.clipboard?.writeText(INSTALL).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      },
      () => setCopied(false),
    )
  }

  return (
    <div className="flex h-[46px] items-center gap-3 rounded-lg border border-lp-line bg-lp-surface ps-4 pe-2">
      <span className="font-mono text-[13.5px] text-lp-muted">{INSTALL}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy "${INSTALL}"`}
        className="cursor-pointer rounded-md border border-lp-line p-1.5 text-lp-dim transition-colors hover:bg-lp-hover hover:text-lp-fg"
      >
        {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
      </button>
    </div>
  )
}

export default function Home() {
  return (
    <HomeLayout {...landingOptions()}>
      {/* The docs theme puts -0.25px on every element; the design does not, and
          each heading below sets its own tracking anyway. */}
      <div className="w-full bg-lp-bg font-landing tracking-normal text-lp-fg">
        <Band className="relative px-6 py-16 sm:px-14 sm:pt-22 sm:pb-18">
          <CornerTicks />
          <Eyebrow>Provider-agnostic OAuth 2.0 · zero dependencies</Eyebrow>
          {/* Wider than the design's 820, and no `text-pretty`: the first line
              measures 874px here, and both of those pull "provider," down. */}
          <h1 className="mt-6 max-w-[920px] text-4xl leading-[1.06] font-semibold tracking-[-0.03em] sm:text-[58px]">
            Sign in with any AI provider, and get a token back.
          </h1>
          <p className="mt-6 max-w-[640px] text-lg leading-[1.65] text-lp-muted text-pretty">
            Every AI CLI ships the same four hundred lines: mint a PKCE pair, open a browser, catch
            the loopback callback, refresh before expiry. This is those lines, extracted once, with
            the provider quirks already encoded.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <PrimaryLink to="/docs">Read the docs</PrimaryLink>
            <SecondaryLink to="/docs/quick-start">Quickstart</SecondaryLink>
            <InstallCommand />
          </div>
        </Band>

        <Band className="px-6 py-14 sm:px-14">
          <div className="mb-7 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
            <h2 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Try it out</h2>
            <span className="text-sm text-lp-dim">
              One command in the terminal, or two lines in your app.
            </span>
          </div>
          <CodeShowcase />
        </Band>

        <Band>
          <div className="border-b border-lp-line px-6 py-5">
            <Eyebrow>Eight providers built in</Eyebrow>
          </div>
          <ProviderGrid tone="landing" />
        </Band>

        <Band>
          <div className="px-6 pt-16 pb-10 sm:px-14">
            <h2 className="max-w-[620px] text-3xl leading-[1.14] font-semibold tracking-[-0.025em] text-pretty sm:text-[34px]">
              The parts every CLI rewrites, already written.
            </h2>
            <p className="mt-4 max-w-[560px] text-base leading-[1.65] text-lp-dim">
              No API client, no proxy, no model wrappers. Redirect the user, receive the callback,
              hand you the token.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-px border-t border-lp-line bg-lp-line sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, index) => (
              <div key={feature.title} className="bg-lp-bg px-7 pt-7 pb-8">
                <div className="font-mono text-xs text-lp-faint">
                  {String(index + 1).padStart(2, '0')}
                </div>
                <div className="mt-3.5 text-[17px] font-semibold">{feature.title}</div>
                <p className="mt-2 text-sm leading-[1.65] text-lp-dim">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </Band>

        <Band>
          <div className="px-6 pt-16 pb-9 sm:px-14">
            <h2 className="text-3xl leading-[1.14] font-semibold tracking-[-0.025em] sm:text-[34px]">Runs anywhere.</h2>
            <p className="mt-4 max-w-[560px] text-base leading-[1.65] text-lp-dim">
              One core with zero dependencies, and a thin adapter per runtime.
            </p>
          </div>
          <div className="border-t border-lp-line">
            {runtimes.map((runtime) => (
              <Link
                key={runtime.pkg}
                to={runtime.href}
                className="grid grid-cols-1 items-center gap-x-6 gap-y-1 border-b border-lp-line px-6 py-4.5 transition-colors last:border-b-0 hover:bg-lp-hover sm:grid-cols-[0.9fr_1.6fr_0.85fr] sm:px-14"
              >
                <div className="text-[15px] font-medium">{runtime.title}</div>
                <div className="text-sm text-lp-dim">{runtime.body}</div>
                <div className="font-mono text-xs sm:text-right">{runtime.pkg}</div>
              </Link>
            ))}
          </div>
        </Band>

        <Band className="relative px-6 py-16 sm:px-14 sm:py-18">
          <CornerTicks bottom={false} />
          <h2 className="text-4xl leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[40px]">
            Open source, forever.
          </h2>
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.65] text-lp-muted">
            MIT licensed, zero dependencies, eight providers built in, and a shape for your own.
            Read the docs and get a token in the next five minutes.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <PrimaryLink to="/docs">Read the docs</PrimaryLink>
            <SecondaryLink to={githubUrl} external>
              Open GitHub
            </SecondaryLink>
          </div>
          <div className="mt-11 rounded-xl border border-lp-line bg-lp-surface px-6 py-6">
            <div className="mb-2 text-[15px] font-semibold">Built for fun and for learning</div>
            <p className="text-sm leading-[1.7] text-lp-dim">
              An independent, unofficial project. Some providers restrict what you may do with a
              credential issued to their own CLI, so obtaining a token here does not mean you are
              allowed to use it. Read their terms and decide for yourself.
            </p>
          </div>
        </Band>

        <Band>
          <div className="grid grid-cols-2 gap-8 px-6 pt-12 pb-9 sm:px-14 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
            <div className="col-span-2 lg:col-span-1">
              <div className="font-mono text-[15px] font-medium">ai-oauth-sdk</div>
              <p className="mt-3 max-w-[280px] text-sm leading-[1.6] text-lp-dim">
                Provider-agnostic OAuth 2.0 for AI CLIs and apps.
              </p>
            </div>
            {footerLinks.map((group) => (
              <div key={group.heading} className="flex flex-col gap-2.5">
                <div className="text-[13px] font-semibold">{group.heading}</div>
                {group.items.map((item) => (
                  <Link
                    key={item.label}
                    to={item.href}
                    {...('external' in item ? { target: '_blank', rel: 'noreferrer' } : {})}
                    className="text-sm text-lp-dim transition-colors hover:text-lp-fg"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-lp-line px-6 pt-4 pb-5 font-mono text-xs text-lp-faint sm:px-14">
            <span>MIT licensed</span>
            <a href="https://themonk.dev" target="_blank" rel="noreferrer">
              themonk.dev
            </a>
          </div>
        </Band>
      </div>
    </HomeLayout>
  )
}
