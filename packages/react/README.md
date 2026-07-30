# @ai-oauth-sdk/react

React bindings for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

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
      {error ? `Retry — ${error.message}` : 'Sign in with ChatGPT'}
    </button>
  )
}
```

Share one session across a tree with `<AuthProvider>` + `useAuthContext()`.

## Notes

The client is memoised on the options that identify it, so re-renders don't drop
in-flight flows or the token cache. State updates are guarded against unmount — OAuth
flows routinely outlive the component that started them, since the user wanders off to
the provider's consent screen and back. Cancelling a login resolves to `undefined`
rather than surfacing an error, because a closed popup is a user action, not a fault.

Works with React 17+. `react` is a peer dependency.

## License

MIT
