import { docsRoute } from './shared'

export interface DocsVersion {
  /** Shown in the picker. */
  label: string
  /** One line of context, shown under the label. */
  description: string
  /** Where this version's docs are served from. */
  href: string
  /** The version currently being written against. Exactly one. */
  current: boolean
}

/**
 * Versions are declared here rather than discovered, because `defineDocs` is a
 * macro: a collection has to exist at build time, so an archived version needs
 * a matching entry in `app/lib/source.ts` either way. Adding one is a
 * three-step change, written down in the repository's docs README.
 */
export const docsVersions: DocsVersion[] = [
  {
    label: 'latest',
    description: 'Tracks main, matching the newest published packages',
    href: docsRoute,
    current: true,
  },
]

export const currentVersion =
  docsVersions.find((version) => version.current) ?? (docsVersions[0] as DocsVersion)

/**
 * Maps a path in the version being read to the same page in another version, so
 * switching keeps the reader where they were rather than dropping them at the
 * index.
 */
export function versionHrefFor(target: DocsVersion, pathname: string): string {
  const base = versionBaseFor(pathname)
  const rest = pathname.slice(base.length).replace(/^\//, '')

  return rest ? `${target.href}/${rest}` : target.href
}

function versionBaseFor(pathname: string): string {
  const match = docsVersions
    .filter((version) => !version.current)
    .find((version) => pathname === version.href || pathname.startsWith(`${version.href}/`))

  return match ? match.href : currentVersion.href
}
