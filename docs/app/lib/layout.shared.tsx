import { RiFingerprintLine, RiNpmjsLine } from '@remixicon/react'

import { appName, githubUrl } from './shared'

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  return {
    themeSwitch: {
      mode: 'light-dark-system',
    },
    nav: {
      url: '/docs',
      title: (
        <>
          <RiFingerprintLine className="size-6" />
          {appName}
        </>
      ),
    },
    githubUrl,
    links: [
      {
        icon: <RiNpmjsLine />,
        text: 'npm',
        url: 'https://www.npmjs.com/package/ai-oauth-sdk',
        active: 'none',
      },
    ],
  }
}
