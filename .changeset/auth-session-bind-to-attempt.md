---
'@ai-oauth-sdk/react-native': patch
---

Bind the Expo auth-session callback to the attempt that started it, the way the deep-link receiver already is.

`deepLinkReceiver` was taught to match a callback to its attempt by `state`, and to compare the redirect URI by whole path, because a custom URL scheme is not a private channel. `authSessionReceiver` was left as it was, and it takes delivery of the same kind of URL: `openAuthSessionAsync` completes on the first URL matching the redirect it was given, and on Android that match is a registered scheme, which any other app on the device may also have registered and which any web page can navigate to. Whatever arrived on it settled the login. A single `?error=access_denied` therefore cancelled a sign-in on demand, since the client's own `state` comparison only guards the success path and a `wait()` that rejects is a failed login whatever the callback was.

The result URL is now checked for the redirect URI's whole path and then for the `state` this receiver actually presented, read from the authorization URL it was handed so the two cannot drift. One that fails either test is dropped, and dropping means the login stays pending rather than failing: a rejection is exactly the cancellation this removes, so refusing a callback must not be another way to spell it. The login then ends on `timeoutMs` or `signal`, which is what they are for. A provider declaring `echoesState: false` is exempt on the same terms as everywhere else, and an authorization URL that carried no `state` leaves nothing to compare, so its callbacks are taken as they come.

A session that did not end in a redirect at all is unchanged and still fails fast. A `type` other than `'success'` is the OS reporting on the sheet this receiver itself opened — the user closing it — so there is nothing to mistake it for and nothing to gain by waiting.
