# @ai-oauth-sdk/solid

SolidJS primitive for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

**[Documentation](https://ai-oauth-sdk.themonk.dev/docs/frameworks/solid)**

```bash
npm i @ai-oauth-sdk/solid @ai-oauth-sdk/browser
```

```tsx
import { Show } from 'solid-js'
import { createAuth } from '@ai-oauth-sdk/solid'
import { popupReceiver } from '@ai-oauth-sdk/browser'

function SignIn() {
  const auth = createAuth({
    provider: 'openai',
    clientId: import.meta.env.VITE_CLIENT_ID,
    receiver: popupReceiver(),
  })

  return (
    <Show
      when={auth.tokens()}
      fallback={
        <button onClick={() => auth.login()} disabled={auth.isLoading()}>
          {auth.error() ? `Retry — ${auth.error()!.message}` : 'Sign in with ChatGPT'}
        </button>
      }
    >
      {(tokens) => <button onClick={() => auth.logout()}>Sign out ({tokens().email})</button>}
    </Show>
  )
}
```

## Notes

Everything is an accessor — call them (`auth.tokens()`) to read inside a
reactive scope. Cleanup runs through `onCleanup`, so the subscription is
released with the owning root; called outside a root it simply does nothing,
which is the correct behaviour there.

Requires Solid 1.8+. `solid-js` is a peer dependency.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. These OAuth flows are not officially supported by any provider and may
change without notice — see the
[disclaimer](https://ai-oauth-sdk.themonk.dev/docs/resources/disclaimer).</sub>
