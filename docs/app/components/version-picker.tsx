import { RiArrowDownSLine, RiPriceTag3Line } from '@remixicon/react'
import { Popover, PopoverContent, PopoverTrigger } from 'fumadocs-ui/components/ui/popover'
import { Link } from 'react-router'

import type { VersionLink } from '@/lib/versions'

/**
 * The sidebar footer stacks its children with no gap, and this sits directly
 * under the GitHub and theme row, so the margin is the only thing keeping the
 * two apart. It matches the footer's own 8px top padding.
 */
const TRIGGER =
  'mt-2 flex w-full items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-2.5 py-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground'

/**
 * Renders as a label while there is one version, and as a dropdown once a
 * second is archived, so the sidebar does not carry a menu with nothing in it.
 *
 * Links arrive resolved: the loader already decided whether this page exists in
 * each version, and pointed the ones that do not at their index instead.
 */
export function VersionPicker({ links }: { links: VersionLink[] }) {
  const active = links.find((link) => link.active) ?? links[0]

  if (!active) {
    return null
  }

  if (links.length < 2) {
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
        {links.map((link) => (
          <Link
            key={link.label}
            to={link.href}
            data-active={link.active}
            className="rounded-md px-2.5 py-2 text-start transition-colors hover:bg-fd-accent data-[active=true]:bg-fd-accent"
          >
            <span className="block text-sm font-medium text-fd-foreground">{link.label}</span>
            <span className="block text-xs text-fd-muted-foreground">{link.description}</span>
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  )
}
