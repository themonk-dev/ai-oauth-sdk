# @ai-oauth-sdk/vue

Vue 3 composable for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

**[Documentation](https://ai-oauth-sdk.pages.dev/docs/frameworks/vue)**

```bash
npm i @ai-oauth-sdk/vue @ai-oauth-sdk/browser
```

```vue
<script setup>
import { useAuth } from '@ai-oauth-sdk/vue'
import { popupReceiver } from '@ai-oauth-sdk/browser'

const { login, logout, tokens, isLoading, error } = useAuth({
  provider: 'openai',
  clientId: import.meta.env.VITE_CLIENT_ID,
  receiver: popupReceiver(),
})
</script>

<template>
  <button v-if="tokens" @click="logout()">Sign out ({{ tokens.email }})</button>
  <button v-else :disabled="isLoading" @click="login()">
    {{ error ? `Retry — ${error.message}` : 'Sign in with ChatGPT' }}
  </button>
</template>
```

## Notes

Returns readonly refs, so template state can't be reassigned by accident.
`tokens` and `error` are `shallowRef`s — a `TokenSet` is replaced wholesale and
never mutated in place, so deep reactivity would only cost proxy overhead.

Cleanup runs through `onScopeDispose`, so this works unchanged inside
`setup()`, a detached `effectScope()`, or a Pinia store.

Cancelling a login (closing the popup) resolves to `undefined` and leaves
`error` untouched — that's a user action, not a failure.

Requires Vue 3.3+. `vue` is a peer dependency.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. These OAuth flows are not officially supported by any provider and may
change without notice — see the
[disclaimer](https://ai-oauth-sdk.pages.dev/docs/resources/disclaimer).</sub>
