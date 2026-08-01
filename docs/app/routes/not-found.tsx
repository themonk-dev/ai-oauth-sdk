import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { Link } from 'react-router'

import { baseOptions } from '@/lib/layout.shared'

export function meta() {
  return [{ title: 'Not found | AI OAuth SDK' }]
}

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <h1 className="mb-2 text-xl font-bold">Not found</h1>
        <p className="mb-4 text-fd-muted-foreground">
          That page does not exist. It may have moved.
        </p>
        <Link
          className="rounded-full bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground"
          to="/docs"
        >
          Back to the docs
        </Link>
      </div>
    </HomeLayout>
  )
}
