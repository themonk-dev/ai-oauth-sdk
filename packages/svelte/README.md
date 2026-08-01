# @ai-oauth-sdk/svelte

Svelte store for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

**[Documentation](https://ai-oauth-sdk.themonk.dev/docs/frameworks/svelte)**

```bash
npm i @ai-oauth-sdk/svelte @ai-oauth-sdk/browser
```

```svelte
<script>
  import { createAuth } from '@ai-oauth-sdk/svelte'
  import { popupReceiver } from '@ai-oauth-sdk/browser'

  const auth = createAuth({
    provider: 'openai',
    clientId: import.meta.env.VITE_CLIENT_ID,
    receiver: popupReceiver(),
  })
</script>

{#if $auth.tokens}
  <button on:click={() => auth.logout()}>Sign out ({$auth.tokens.email})</button>
{:else}
  <button on:click={() => auth.login()} disabled={$auth.isLoading}>
    {$auth.error ? `Retry — ${$auth.error.message}` : 'Sign in with ChatGPT'}
  </button>
{/if}
```

## Notes

`$auth` gives you `{ tokens, isAuthenticated, isLoading, error }`; the actions
(`login`, `logout`, `refresh`, `getAccessToken`, `cancel`) hang off the store
object itself.

The core store already satisfies Svelte's contract — `subscribe(fn)` emits the
current value immediately and returns an unsubscribe function — so this package
is a thin typing layer rather than a reimplementation. `svelte` is an optional
peer dependency, and nothing here imports from it, so the store also works in
plain JS or with any other consumer of that contract.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. These OAuth flows are not officially supported by any provider and may
change without notice — see the
[disclaimer](https://ai-oauth-sdk.themonk.dev/docs/resources/disclaimer).</sub>
