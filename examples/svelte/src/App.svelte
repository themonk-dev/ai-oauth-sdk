<script lang="ts">
  import { popupReceiver } from '@ai-oauth-sdk/browser'
  import { createAuth } from '@ai-oauth-sdk/svelte'
  import { demoProvider, demoRedirectUri } from '@ai-oauth-sdk-example/shared/demo-provider'

  // `$auth` gives { tokens, isAuthenticated, isLoading, error }; the actions
  // hang off the store object itself.
  const auth = createAuth({
    provider: demoProvider,
    redirectUri: demoRedirectUri,
    // Must come from a user gesture, or the browser blocks the popup.
    receiver: popupReceiver({ redirectUri: demoRedirectUri }),
  })

  const summary = (tokens: NonNullable<typeof $auth.tokens>) => ({
    accessToken: `${tokens.accessToken.slice(0, 22)}…`,
    expiresAt: tokens.expiresAt && new Date(tokens.expiresAt).toLocaleTimeString(),
    scope: tokens.scope,
  })
</script>

<main class="card">
  <div class="eyebrow">@ai-oauth-sdk/svelte</div>
  <h1>createAuth()</h1>

  {#if $auth.tokens}
    <p>Signed in as <strong>{$auth.tokens.email ?? $auth.tokens.accountId}</strong>.</p>
    <pre>{JSON.stringify(summary($auth.tokens), null, 2)}</pre>
    <div class="row">
      <button class="secondary" disabled={$auth.isLoading} on:click={() => auth.refresh()}>
        Refresh token
      </button>
      <button class="secondary" on:click={() => auth.logout()}>Sign out</button>
    </div>
  {:else}
    <p>
      Signing in opens a popup served by Vite — a real authorization-code + PKCE
      flow against a mock provider, so this works offline.
    </p>
    <button disabled={$auth.isLoading} on:click={() => auth.login()}>
      {$auth.isLoading ? 'Waiting for the popup…' : 'Sign in'}
    </button>
  {/if}

  <!-- Cancelling (closing the popup) is not an error, so nothing shows here. -->
  {#if $auth.error}
    <p class="error">{$auth.error.message}</p>
  {/if}
</main>
