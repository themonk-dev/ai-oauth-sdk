# @ai-oauth-sdk/react-native

React Native / Expo adapter for [`ai-oauth-sdk`](https://github.com/themonk-dev/ai-oauth-sdk).

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

## Bare React Native

```ts
import { Linking } from 'react-native'
import { deepLinkReceiver } from '@ai-oauth-sdk/react-native'

const tokens = await client.login({
  receiver: deepLinkReceiver({ linking: Linking, redirectUri: 'myapp://auth/callback' }),
})
```

It also checks `getInitialURL()`, which is how the redirect arrives when the OS killed
your app while the user was on the consent screen.

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
object — enough to break an authorization URL before the browser even opens. So the
OAuth path never touches either global: query strings are built and parsed internally,
byte-for-byte identically to what `URLSearchParams` would emit, which the test suite
asserts against the real implementation across the whole ASCII range.

Install the polyfill if your own code wants a spec-compliant `URL`. Nothing here needs it.

## Storage

`secureStoreAdapter(SecureStore)` — Keychain / EncryptedSharedPreferences. Use this for
refresh tokens. `asyncStorageAdapter(AsyncStorage)` is available but is not encrypted
at rest.

## License

MIT
