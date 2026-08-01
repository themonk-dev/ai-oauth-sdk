import { RiArrowDownSLine, RiPriceTag3Line } from '@remixicon/react'
import { Popover, PopoverContent, PopoverTrigger } from 'fumadocs-ui/components/ui/popover'
import { Link, useLocation } from 'react-router'

import { currentVersion, docsVersions, versionHrefFor } from '@/lib/versions'

const TRIGGER =
  'flex w-full items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-2.5 py-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground'

/**
 * Renders as a label while there is one version, and as a dropdown once a
 * second is archived, so the sidebar does not carry a menu with nothing in it.
 */
export function VersionPicker() {
  const { pathname } = useLocation()
  const active =
    docsVersions.find(
      (version) =>
        !version.current &&
        (pathname === version.href || pathname.startsWith(`${version.href}/`)),
    ) ?? currentVersion

  if (docsVersions.length < 2) {
    return (
      <span className={TRIGGER}>
        <RiPriceTag3Line className="size-3.5 shrink-0" />
        Version: {active.label}
      </span>
    )
  }

  return (
    <Popover>
      <PopoverTrigger className={TRIGGER}>
        <RiPriceTag3Line className="size-3.5 shrink-0" />
        Version: {active.label}
        <RiArrowDownSLine className="ms-auto size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-1 p-1">
        {docsVersions.map((version) => (
          <Link
            key={version.href}
            to={versionHrefFor(version, pathname)}
            data-active={version.href === active.href}
            className="rounded-md px-2.5 py-2 text-start transition-colors hover:bg-fd-accent data-[active=true]:bg-fd-accent"
          >
            <span className="block text-sm font-medium text-fd-foreground">{version.label}</span>
            <span className="block text-xs text-fd-muted-foreground">{version.description}</span>
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  )
}
