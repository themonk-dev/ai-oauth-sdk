import { popupReceiver } from '@ai-oauth-sdk/browser'
import { useAuth } from '@ai-oauth-sdk/react'
import { demoProvider, demoRedirectUri } from '@ai-oauth-sdk-example/shared/demo-provider'

export function App() {
  const { login, logout, refresh, tokens, isAuthenticated, isLoading, error } = useAuth({
    provider: demoProvider,
    redirectUri: demoRedirectUri,
    // Must come from a user gesture, or the browser blocks the popup —
    // which is why login() is called straight from onClick below.
    receiver: popupReceiver({ redirectUri: demoRedirectUri }),
  })

  return (
    <main className="card">
      <div className="eyebrow">@ai-oauth-sdk/react</div>
      <h1>useAuth()</h1>

      {isAuthenticated ? (
        <>
          <p>
            Signed in as <strong>{tokens?.email ?? tokens?.accountId}</strong>.
          </p>
          <pre>
            {JSON.stringify(
              {
                accessToken: `${tokens?.accessToken?.slice(0, 22)}…`,
                expiresAt: tokens?.expiresAt && new Date(tokens.expiresAt).toLocaleTimeString(),
                scope: tokens?.scope,
              },
              null,
              2,
            )}
          </pre>
          <div className="row">
            <button className="secondary" onClick={() => void refresh()} disabled={isLoading}>
              Refresh token
            </button>
            <button className="secondary" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Signing in opens a popup served by Vite — a real authorization-code + PKCE
            flow against a mock provider, so this works offline.
          </p>
          <button onClick={() => void login()} disabled={isLoading}>
            {isLoading ? 'Waiting for the popup…' : 'Sign in'}
          </button>
        </>
      )}

      {/* Cancelling (closing the popup) is not an error, so nothing shows here. */}
      {error && <p className="error">{error.message}</p>}
    </main>
  )
}
