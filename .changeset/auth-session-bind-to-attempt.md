---
'@ai-oauth-sdk/react-native': patch
---

Bind `authSessionReceiver` callbacks to the attempt that started them.

`deepLinkReceiver` matches a callback to the attempt it presented, by `state`, because a custom URL scheme is not a private channel. `authSessionReceiver` did not: it handed whatever URL the session returned straight to the parser, and an `error=` payload there rejects `wait()` and fails the live sign-in — the client's own `state` comparison only guards the success path, so it cannot catch that.

On Android the session *is* a deep link. `expo-web-browser` has a native auth session on iOS and macOS only; elsewhere it polyfills the sheet over `Linking` and resolves it on any URL whose text begins with the redirect URI. So any app on the device that can fire the scheme decided what the sheet returned, and a single `myapp://auth/callback?error=access_denied` cancelled a sign-in on demand. The prefix test is looser than the deep-link path's whole-path compare, so `myapp://auth/callbackXYZ?error=...` matched as well. An injected `?code=` was never a way in — it dies on the client's constant-time `state` check — so what was at stake is a sign-in someone else can cancel, not a token.

The result URL is now matched to the attempt by `state`, read from the authorization URL handed to `present()` so the two cannot drift, and one that disagrees, or that carries no `state` where one was presented, leaves `wait()` pending rather than settling it. Give `login()` a `timeoutMs` or a `signal`, as on the deep-link path. A provider that sends no `state`, or declares `echoesState: false`, leaves nothing to compare and its callbacks are taken as they come.

A sheet that closes without a redirect still settles as an abort straight away, whatever the attempt carried. That is the user dismissing it, in front of them, and it is theirs to do at any time.
