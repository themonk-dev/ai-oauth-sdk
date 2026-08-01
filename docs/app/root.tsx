import { RootProvider } from 'fumadocs-ui/provider/react-router'
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'

import SearchDialog from '@/components/search'
import { appName } from '@/lib/shared'
import NotFound from './routes/not-found'

import type { Route } from './+types/root'
import './app.css'

export const links: Route.LinksFunction = () => [
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=Geist+Mono:wght@100..900&display=swap',
  },
]

export const meta: Route.MetaFunction = () => [
  { title: `${appName} Documentation` },
  {
    name: 'description',
    content:
      'Provider-agnostic OAuth for AI CLIs and apps. Sign in with ChatGPT, Claude, Gemini, Copilot or Grok and get a token back.',
  },
]

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog }}>{children}</RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Something went wrong'
  let details = 'An unexpected error occurred.'
  let stack: string | undefined

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return <NotFound />
    }

    message = 'Error'
    details = error.statusText
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message
    stack = error.stack
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] p-4 pt-16">
      <h1 className="mb-2 text-xl font-bold">{message}</h1>
      <p className="text-fd-muted-foreground">{details}</p>

      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  )
}
