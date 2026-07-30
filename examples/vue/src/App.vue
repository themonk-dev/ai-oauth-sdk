<script setup lang="ts">
import { popupReceiver } from '@ai-oauth-sdk/browser'
import { useAuth } from '@ai-oauth-sdk/vue'
import { demoProvider, demoRedirectUri } from '@ai-oauth-sdk-example/shared/demo-provider'

const { login, logout, refresh, tokens, isAuthenticated, isLoading, error } = useAuth({
  provider: demoProvider,
  redirectUri: demoRedirectUri,
  // Must come from a user gesture, or the browser blocks the popup — which is
  // why login() is bound straight to @click below.
  receiver: popupReceiver({ redirectUri: demoRedirectUri }),
})

const summary = () => ({
  accessToken: `${tokens.value?.accessToken?.slice(0, 22)}…`,
  expiresAt: tokens.value?.expiresAt && new Date(tokens.value.expiresAt).toLocaleTimeString(),
  scope: tokens.value?.scope,
})
</script>

<template>
  <main class="card">
    <div class="eyebrow">@ai-oauth-sdk/vue</div>
    <h1>useAuth()</h1>

    <template v-if="isAuthenticated">
      <p>
        Signed in as <strong>{{ tokens?.email ?? tokens?.accountId }}</strong>.
      </p>
      <pre>{{ JSON.stringify(summary(), null, 2) }}</pre>
      <div class="row">
        <button class="secondary" :disabled="isLoading" @click="refresh()">Refresh token</button>
        <button class="secondary" @click="logout()">Sign out</button>
      </div>
    </template>

    <template v-else>
      <p>
        Signing in opens a popup served by Vite — a real authorization-code + PKCE
        flow against a mock provider, so this works offline.
      </p>
      <button :disabled="isLoading" @click="login()">
        {{ isLoading ? 'Waiting for the popup…' : 'Sign in' }}
      </button>
    </template>

    <!-- Cancelling (closing the popup) is not an error, so nothing shows here. -->
    <p v-if="error" class="error">{{ error.message }}</p>
  </main>
</template>
