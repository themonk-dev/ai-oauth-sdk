import { docsRoute, sdkVersion } from './shared'

export interface DocsVersion {
  /** Matches the collection key in `app/lib/docs-page.tsx`. */
  key: string
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
 * four-step change, written down in the repository's docs README.
 *
 * Slugs carry no dot. `0.3` in a path makes some static hosts read the segment
 * as a filename and answer with a directory listing instead of the page, so the
 * label and the slug are allowed to differ.
 */
export const docsVersions: DocsVersion[] = [
  {
    key: 'latest',
    label: `latest (${sdkVersion})`,
    description: 'Tracks main, matching the newest published packages',
    href: docsRoute,
    current: true,
  },
  {
    key: '0.3',
    label: '0.3',
    description: 'Before providers were renamed to claude, gemini and azure-ai',
    href: `${docsRoute}/v/0-3`,
    current: false,
  },
]

export const currentVersion =
  docsVersions.find((version) => version.current) ?? (docsVersions[0] as DocsVersion)

/** A version as the picker renders it, with the link already resolved. */
export interface VersionLink {
  label: string
  description: string
  href: string
  active: boolean
}
