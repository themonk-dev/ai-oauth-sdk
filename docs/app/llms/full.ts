import { getLLMText, source } from '@/lib/source'

export async function loader() {
  const scanned = await Promise.all(source.getPages().map(getLLMText))

  return new Response(scanned.join('\n\n'))
}
