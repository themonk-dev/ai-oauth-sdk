import { useFumadocsLoader } from 'fumadocs-core/source/client'
import { DocsLayout, type DocsLayoutProps } from 'fumadocs-ui/layouts/docs'
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page'
import { use } from 'react'

import { useMDXComponents } from '@/components/mdx'
import { providerLogos } from '@/components/provider-logos'
import { VersionPicker } from '@/components/version-picker'
import { docsVersions, type VersionLink } from './versions'
import { icons } from './icons'
import { baseOptions } from './layout.shared'
import { pageMeta } from './seo'
import { appName, gitConfig } from './shared'
import { docs, docsV03, getPageMarkdownUrl, source, sourceV03 } from './source'

/** Every documentation collection, keyed by the version it belongs to. */
const collections = {
  latest: { source, docs },
  '0.3': { source: sourceV03, docs: docsV03 },
} as const

export type DocsVersionKey = keyof typeof collections

/**
 * Two routes render a documentation page: an index route for `/`, and a splat
 * for everything below it. React Router matches an empty remainder against the
 * root layout rather than the splat, so one route cannot serve both.
 */
export async function loadDocsPage(slugs: string[], version: DocsVersionKey = 'latest') {
  const collection = collections[version]
  const page = collection.source.getPage(slugs)

  if (!page) {
    throw new Response('Not found', { status: 404 })
  }

  return {
    path: page.path,
    url: page.url,
    version,
    title: page.data.title,
    description: page.data.description ?? '',
    markdownUrl: version === 'latest' ? getPageMarkdownUrl(page).url : '',
    versionLinks: resolveVersionLinks(slugs, version),
    pageTree: await collection.source.serializePageTree(collection.source.getPageTree()),
  }
}

/**
 * Points each version at the same page, or at its index when that page does not
 * exist there.
 *
 * The fallback is the whole reason this runs here rather than in the browser:
 * `/docs/providers/claude` has no counterpart in 0.3, where it was called
 * `anthropic`, and a picker that assumed otherwise would send readers to a 404
 * on exactly the pages a rename touched. Every collection is in memory at build
 * time, so the answer is a lookup.
 */
function resolveVersionLinks(slugs: string[], version: DocsVersionKey): VersionLink[] {
  return docsVersions.map((entry) => {
    const target = collections[entry.key as DocsVersionKey]
    const exists = Boolean(target?.source.getPage(slugs))

    return {
      label: entry.label,
      description: entry.description,
      href: exists ? [entry.href, ...slugs].join('/') : entry.href,
      active: entry.key === version,
    }
  })
}

export type DocsPageData = Awaited<ReturnType<typeof loadDocsPage>>

/**
 * Every page under `providers/` is named after the provider id, so its brand
 * mark is a lookup. The sidebar keeps its Remix icon either way: these marks
 * carry too much detail to read at 16px.
 */
function providerIdFor(path: string) {
  const match = /^providers\/(.+)\.mdx$/.exec(path)

  return match?.[1]
}

export function docsPageMeta(data: DocsPageData | undefined) {
  if (!data) {
    return [{ title: appName }]
  }

  return pageMeta({
    title: `${data.title} | ${appName}`,
    description: data.description,
    path: data.url,
  })
}

function Content({
  path,
  markdownUrl,
  version,
}: {
  path: string
  markdownUrl: string
  version: DocsVersionKey
}) {
  const page = collections[version].docs.getPage(path)

  if (!page) {
    throw new Error(`unknown page: ${path}`)
  }

  const { toc } = use(page.load())
  const Mdx = page.body
  const Logo = providerLogos[providerIdFor(path) ?? '']
  const Icon = typeof page.icon === 'string' ? icons[page.icon] : undefined

  return (
    <DocsPage toc={toc} tableOfContent={{ style: 'clerk' }}>
      <DocsTitle className="flex items-center gap-3">
        {Logo ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-fd-border bg-fd-card">
            <Logo className="size-5" />
          </span>
        ) : (
          Icon && (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary">
              <Icon className="size-5" />
            </span>
          )
        )}
        {page.title}
      </DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>

      {/* Only the live docs have a markdown route and a file on the branch behind
          them. An archived page is a frozen copy, so these controls are hidden
          rather than pointed at something that would 404. */}
      {version === 'latest' && (
        <nav
          aria-label="Page actions"
          className="-mt-4 flex flex-row items-center gap-2 border-b pb-6"
        >
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs/content/${path}`}
          />
        </nav>
      )}

      <DocsBody>
        <Mdx components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

export function DocsPageView({ loaderData }: { loaderData: DocsPageData }) {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(loaderData)
  const sidebar: DocsLayoutProps['sidebar'] = {
    footer: <VersionPicker links={loaderData.versionLinks} />,
  }

  return (
    <DocsLayout {...baseOptions()} tree={pageTree} sidebar={sidebar}>
      <Content path={path} markdownUrl={markdownUrl} version={loaderData.version} />
    </DocsLayout>
  )
}
