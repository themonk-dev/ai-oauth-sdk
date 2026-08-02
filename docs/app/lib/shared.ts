export const appName = 'AI OAuth SDK'

/** Substituted at build time from `packages/core/package.json`. */
declare const __SDK_VERSION__: string

export const sdkVersion = __SDK_VERSION__

export const siteUrl = 'https://ai-oauth.themonk.dev'

export const docsRoute = '/docs'
export const docsContentRoute = '/llms.mdx'

export const gitConfig = {
  user: 'themonk-dev',
  repo: 'ai-oauth-sdk',
  branch: 'main',
}

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`
