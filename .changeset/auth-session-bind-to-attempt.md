---
'@ai-oauth-sdk/react-native': patch
---

Bind the Expo auth-session result to the attempt that presented it.

`authSessionReceiver` settled the login from whatever URL `openAuthSessionAsync` resolved with and never compared it to the authorization URL it had presented. Its deep-link sibling was given exactly that binding in the previous release; this one was left out, and on Android the two are the same channel.

No Android version has the native auth session, so `expo-web-browser` falls back to a JavaScript polyfill: it opens a Custom Tab, listens on `Linking`, and resolves on the first event whose URL starts with the redirect URI. That is the whole filter. Any app on the device, and any web page the user follows a link from, can fire `myapp://auth/callback?error=access_denied` and fail a live sign-in — reported as the provider's own `authorization_denied`, because `readCallback` parsed the foreign URL as ours. A denial echoing an openly wrong `state` did the same, there being no comparison to fail. A forged `code` was already stopped by the client's own `state` check, which runs on the success path. iOS and web use the native `ASWebAuthenticationSession`, which returns only the redirect it saw, and are unaffected.

The result is now matched to the presented `state`, read from the URL handed to `present()` so the two cannot drift, and one that disagrees — or that carries none where one was presented — is refused as `state_mismatch`. A provider declaring `echoesState: false` is exempt, as it is for deep links.

The refusal is fast rather than patient, which is the opposite of what the deep-link receiver does and is deliberate. By the time the polyfill has resolved it has removed its `Linking` subscription and settled its promise, so nothing is listening for the genuine redirect any more; dropping the foreign URL and waiting would turn an immediate failure into a hang until `timeoutMs`. So the denial-of-sign-in still succeeds on Android and `login()` has to be retried. What this buys is that a URL belonging to someone else is not parsed as the callback, and the failure is not misreported as the provider's — error attribution, not availability. The README and the React Native and receivers docs now say so; they previously described Android only as "Custom Tabs".
