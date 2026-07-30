import { Show } from 'solid-js'
import { popupReceiver } from '@ai-oauth-sdk/browser'
import { createAuth } from '@ai-oauth-sdk/solid'
import { demoProvider, demoRedirectUri } from '@ai-oauth-sdk-example/shared/demo-provider'

export function App() {
  const auth = createAuth({
    provider: demoProvider,
    redirectUri: demoRedirectUri,
    // Must come from a user gesture, or the browser blocks the popup.
    receiver: popupReceiver({ redirectUri: demoRedirectUri }),
  })

  return (
    <main class="card">
      <div class="eyebrow">@ai-oauth-sdk/solid</div>
      <h1>createAuth()</h1>

      <Show
        when={auth.tokens()}
        fallback={
          <>
            <p>
              Signing in opens a popup served by Vite — a real authorization-code + PKCE
              flow against a mock provider, so this works offline.
            </p>
            <button onClick={() => void auth.login()} disabled={auth.isLoading()}>
              {auth.isLoading() ? 'Waiting for the popup…' : 'Sign in'}
            </button>
          </>
        }
      >
        {(tokens) => (
          <>
            <p>
              Signed in as <strong>{tokens().email ?? tokens().accountId}</strong>.
            </p>
            <pre>
              {JSON.stringify(
                {
                  accessToken: `${tokens().accessToken.slice(0, 22)}…`,
                  expiresAt:
                    tokens().expiresAt && new Date(tokens().expiresAt!).toLocaleTimeString(),
                  scope: tokens().scope,
                },
                null,
                2,
              )}
            </pre>
            <div class="row">
              <button
                class="secondary"
                onClick={() => void auth.refresh()}
                disabled={auth.isLoading()}
              >
                Refresh token
              </button>
              <button class="secondary" onClick={() => void auth.logout()}>
                Sign out
              </button>
            </div>
          </>
        )}
      </Show>

      {/* Cancelling (closing the popup) is not an error, so nothing shows here. */}
      <Show when={auth.error()}>{(error) => <p class="error">{error().message}</p>}</Show>
    </main>
  )
}
