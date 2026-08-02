# @ai-oauth-sdk/react

React bindings for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

**[Documentation](https://ai-oauth-sdk.themonk.dev/docs/frameworks/react)**

```bash
npm i @ai-oauth-sdk/react @ai-oauth-sdk/browser
```

```tsx
import { useAuth } from '@ai-oauth-sdk/react'
import { popupReceiver } from '@ai-oauth-sdk/browser'

function SignIn() {
  const { login, logout, tokens, isLoading, error } = useAuth({
    provider: 'openai',
    clientId,
    receiver: popupReceiver(),
  })

  if (tokens) return <button onClick={logout}>Sign out ({tokens.email})</button>
  return (
    <button onClick={() => login()} disabled={isLoading}>
      {error ? `Retry: ${error.message}` : 'Sign in with ChatGPT'}
    </button>
  )
}
```

Share one session across a tree with `<AuthProvider>` + `useAuthContext()`.

## Notes

The client is memoised on the options that identify it, so re-renders do not drop in-flight flows
or the token cache.

State updates are guarded against unmount, because OAuth flows routinely outlive the component that
started them. The user wanders off to the provider's consent screen and comes back, and by then the
component may be long gone.

Cancelling a login resolves to `undefined` rather than surfacing an error. A closed popup is a user
action, not a fault.

Works with React 17+. `react` is a peer dependency.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. No provider officially supports these OAuth flows, and any of them may
change without notice. Please read the
[disclaimer](https://ai-oauth-sdk.themonk.dev/docs/resources/disclaimer).</sub>
