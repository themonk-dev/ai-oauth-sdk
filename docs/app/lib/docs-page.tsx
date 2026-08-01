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
import { Link } from 'react-router'

import { useMDXComponents } from '@/components/mdx'
import { baseOptions } from './layout.shared'
import { gitConfig } from './shared'
import { docs, getPageMarkdownUrl, source } from './source'

/**
 * Two routes render a documentation page: an index route for `/`, and a splat
 * for everything below it. React Router matches the empty remainder against the
 * root layout rather than the splat, so one route cannot serve both.
 */
export async function loadDocsPage(slugs: string[]) {
  const page = source.getPage(slugs)

  if (!page) {
    throw new Response('Not found', { status: 404 })
  }

  return {
    path: page.path,
    title: page.data.title,
    description: page.data.description ?? '',
    markdownUrl: getPageMarkdownUrl(page).url,
    pageTree: await source.serializePageTree(source.getPageTree()),
  }
}

export type DocsPageData = Awaited<ReturnType<typeof loadDocsPage>>

export function docsPageMeta(data: DocsPageData | undefined) {
  if (!data) {
    return [{ title: 'AI OAuth SDK' }]
  }

  return [
    { title: `${data.title} | AI OAuth SDK` },
    { name: 'description', content: data.description },
  ]
}

const sidebar: DocsLayoutProps['sidebar'] = {
  footer: (
    <Link
      to="/resources/disclaimer"
      className="flex items-center justify-center gap-2 py-2 text-xs text-fd-muted-foreground transition-colors hover:text-fd-foreground"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
      </span>
      Unofficial project
    </Link>
  ),
}

function Content({ path, markdownUrl }: { path: string; markdownUrl: string }) {
  const page = docs.getPage(path)

  if (!page) {
    throw new Error(`unknown page: ${path}`)
  }

  const { toc } = use(page.load())
  const Mdx = page.body

  return (
    <DocsPage toc={toc} tableOfContent={{ style: 'clerk' }}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
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
      <DocsBody>
        <Mdx components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

export function DocsPageView({ loaderData }: { loaderData: DocsPageData }) {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(loaderData)

  return (
    <DocsLayout {...baseOptions()} tree={pageTree} sidebar={sidebar}>
      <Content path={path} markdownUrl={markdownUrl} />
    </DocsLayout>
  )
}
