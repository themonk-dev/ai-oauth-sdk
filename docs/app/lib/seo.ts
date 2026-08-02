import { appName, githubUrl, siteUrl } from './shared'

/**
 * One card for the whole site. A crawler fetches `og:image` once and the
 * platform caches it, so this cannot follow the reader's theme the way the
 * pages do. The light card is the one that ships; `og-dark.png` is there for
 * places that *can* choose, such as a `<picture>` in the README.
 */
const ogImage = `${siteUrl}/og.png`
const ogImageAlt = 'ai-oauth-sdk: sign in with any AI provider, wire it into any harness.'

export interface PageSeo {
  title: string
  description: string
  path: string
}

export function pageMeta({ title, description, path }: PageSeo) {
  const url = `${siteUrl}${path}`

  return [
    { title },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: url },

    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: appName },
    { property: 'og:locale', content: 'en_US' },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:url', content: url },
    { property: 'og:image', content: ogImage },
    { property: 'og:image:type', content: 'image/png' },
    { property: 'og:image:width', content: '1200' },
    { property: 'og:image:height', content: '630' },
    { property: 'og:image:alt', content: ogImageAlt },

    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: ogImage },
    { name: 'twitter:image:alt', content: ogImageAlt },
  ]
}

/**
 * Structured data, on the home page only. Repeating it per page would say the
 * same thing many times over and dilute what it is worth.
 */
export function homeStructuredData(version: string) {
  return {
    'script:ld+json': {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${siteUrl}#website`,
          url: siteUrl,
          name: appName,
          description:
            'Provider-agnostic OAuth 2.0 for AI CLIs and apps. Redirect the user, receive the callback, get a token back.',
          inLanguage: 'en',
        },
        {
          '@type': 'SoftwareSourceCode',
          '@id': `${siteUrl}#software`,
          name: 'ai-oauth-sdk',
          description:
            'OAuth 2.0 and PKCE for AI providers. Sign in with ChatGPT, Claude, Gemini, Grok, Copilot, Qwen, OpenRouter or Azure AI and get the token back. Zero dependencies.',
          url: siteUrl,
          codeRepository: githubUrl,
          programmingLanguage: 'TypeScript',
          runtimePlatform: ['Node.js', 'Bun', 'Deno', 'Browser', 'React Native'],
          license: 'https://opensource.org/licenses/MIT',
          version,
          author: { '@type': 'Organization', name: 'themonk.dev', url: 'https://themonk.dev' },
          keywords: [
            'oauth',
            'oauth2',
            'pkce',
            'ai',
            'chatgpt',
            'claude',
            'gemini',
            'grok',
            'github copilot',
            'authentication',
          ],
        },
      ],
    },
  }
}
