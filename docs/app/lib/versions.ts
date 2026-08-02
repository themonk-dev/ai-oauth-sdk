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
 * a matching entry in `app/lib/source.ts` either way. Adding one is a four-step
 * change, written down in the docs README.
 *
 * The picker renders as a plain label while this list holds one entry, and
 * becomes a dropdown once it holds more.
 */
export const docsVersions: DocsVersion[] = [
  {
    key: 'latest',
    label: `latest (${sdkVersion})`,
    description: 'Tracks main, matching the newest published packages',
    href: docsRoute,
    current: true,
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
