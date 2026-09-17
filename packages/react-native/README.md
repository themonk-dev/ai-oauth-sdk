# @ai-oauth-sdk/react-native

React Native / Expo adapter for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

**[Documentation](https://ai-oauth.themonk.dev/docs/runtimes/react-native)**

```bash
npm i @ai-oauth-sdk/react-native
```

**No peer dependencies.** The RN and Expo modules are passed in rather than imported,
so this package installs and typechecks whether or not you use Expo.

## Expo

```ts
import * as WebBrowser from 'expo-web-browser'
import * as SecureStore from 'expo-secure-store'
import { createAuthClient, authSessionReceiver, secureStoreAdapter } from '@ai-oauth-sdk/react-native'

const client = createAuthClient({
  provider: 'openai',
  clientId,
  storage: secureStoreAdapter(SecureStore),
})

const tokens = await client.login({
  receiver: authSessionReceiver({ webBrowser: WebBrowser, redirectUri: 'myapp://auth/callback' }),
})
```

`authSessionReceiver` uses `SFAuthenticationSession` / Custom Tabs, so the user keeps
their provider cookies and the OS closes the sheet on redirect.

Android has no native auth session, so `expo-web-browser` polyfills one: it opens a
Custom Tab and resolves from the first `Linking` deep link that starts with your redirect
URI — which any app on the device, or any web page the user follows a link from, can
fire. The receiver matches the result to the attempt it presented, by `state`, and
refuses one that disagrees or that carries none where one was presented, so a stray
`?error=access_denied` is no longer reported as the provider's own denial. It cannot
recover the sign-in, though: the polyfill stops listening once anything matched, so the
real redirect has nowhere to land and `login()` has to be retried. iOS and web use the
native session and are unaffected.

## Bare React Native

```ts
import { Linking } from 'react-native'
import { deepLinkReceiver } from '@ai-oauth-sdk/react-native'

const tokens = await client.login({
  receiver: deepLinkReceiver({ linking: Linking, redirectUri: 'myapp://auth/callback' }),
})
```

A custom URL scheme is open to every app on the device, so the receiver matches the
callback to the attempt it presented, by `state`. A deep link whose `state` disagrees —
or that carries none where one was presented — is dropped instead of settling the login.
That includes `?error=...`, which RFC 6749 requires a provider to echo `state` on; a
provider that does not leaves the login pending rather than failing it, so pass
`timeoutMs` (or a `signal`) to `login()`.

### Cold start

If the OS killed your app while the user was on the consent screen, the redirect arrives
as the launch URL rather than a `url` event, and `login()` cannot pick it up: the
relaunched app starts a fresh authorization with a fresh `state`, which the old URL can
never match. Finish it yourself instead — the pending record is stored under its `state`,
so with a persistent storage adapter, and inside the authorization TTL (10 minutes by
default), this completes the flow the killed process started:

```ts
const callbackUrl = await Linking.getInitialURL()

if (callbackUrl?.startsWith('myapp://auth/callback')) {
  await client.completeAuthorization({ callbackUrl })
}
```

## Crypto

**No polyfill needed.** Hermes ships without `crypto.subtle`, so PKCE challenges use a
bundled pure-JS SHA-256, verified against WebCrypto and the FIPS 180-4 vectors.

Randomness is different: if `crypto.getRandomValues` is missing, the library throws
rather than weakening your `state` and verifier. On bare RN add
`react-native-get-random-values` and import it once at the top of your entry file; on
Expo use `expo-standard-web-crypto`.

## URLs

**No `react-native-url-polyfill` either.** React Native's built-in URL shim throws from
its `searchParams` getter, and its `URLSearchParams` has historically accepted only an
object, which is enough to break an authorization URL before the browser even opens. So the
OAuth path never touches either global: query strings are built and parsed internally,
byte-for-byte identically to what `URLSearchParams` would emit, which the test suite
asserts against the real implementation across the whole ASCII range.

Install the polyfill if your own code wants a spec-compliant `URL`. Nothing here needs it.

## Storage

`secureStoreAdapter(SecureStore)` uses the Keychain on iOS and EncryptedSharedPreferences on
Android. Use it for refresh tokens. `asyncStorageAdapter(AsyncStorage)` is available too, but it is
not encrypted at rest.

## License

MIT

---

<sub>An independent, unofficial project. Not affiliated with or endorsed by OpenAI,
Anthropic, Google, GitHub, Microsoft, xAI, Alibaba or OpenRouter; all trademarks belong
to their owners. No provider officially supports these OAuth flows, and any of them may
change without notice. Please read the
[disclaimer](https://ai-oauth.themonk.dev/docs/resources/disclaimer).</sub>
