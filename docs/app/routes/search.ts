import { createFromSource } from 'fumadocs-core/search/server'

import { source } from '@/lib/source'

// Static index: there is no server to query at runtime, so the whole index is
// emitted at build time and searched in the browser.
const server = createFromSource(source, { language: 'english' })

export async function loader() {
  return server.staticGET()
}
