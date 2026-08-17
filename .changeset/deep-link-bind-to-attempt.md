---
'@ai-oauth-sdk/react-native': patch
'@ai-oauth-sdk/core': minor
---

Bind deep-link callbacks to the attempt that started them, and stop replaying the launch URL.

A custom URL scheme is not a private channel. Any other app on the device, and any web page the user follows a link from, can send `myapp://auth/callback?...` into the receiver, and it settled the login from anything whose path matched the redirect URI. A single unsolicited `?error=access_denied` therefore cancelled a sign-in on demand — the client's own `state` comparison only guards the success path, so a `wait()` that rejects is a failed login whatever the callback was. The loopback receiver turns away the subresource form of the same request, using the `Sec-Fetch-*` headers a browser attaches; the mobile one had no equivalent of any kind, and a custom scheme carries no such headers to judge by.

The same hole was reachable without anyone sending anything. `wait()` read `getInitialURL()` unconditionally, and that source does not drain: it keeps returning the URL that cold-started the app for the life of the process. A callback bound to nothing was replayed into every later login in that process.

Callbacks are now matched to the attempt by `state`, read from the authorization URL handed to `present()` so the two cannot drift, and one that disagrees is dropped rather than settling the login. A callback carrying no `state` where one was presented is dropped too: on a custom scheme "not ours" is the default, and RFC 6749 §4.1.2.1 requires `state` to be echoed on error responses as well as successful ones, so nothing legitimate is turned away. A provider that ignores that rule leaves the login pending rather than failing it, which is what `timeoutMs` and `signal` are for. A provider that sends no `state` at all leaves nothing to compare, and its callbacks are still taken as they come. The redirect URI is now compared by whole path rather than by prefix, so `myapp://auth/callbackXYZ` is no longer treated as the callback screen.

`parseQuery` is exported from core for this: a receiver reading a param back out of an authorization URL needs the same parser the URL was built with, and bare React Native cannot reliably reach for `URLSearchParams` to do it.

The documented cold-start resume was corrected rather than kept. It could not work and never could: the relaunched app calls `createAuthorization()` again, which mints a fresh `state`, so the URL from before the kill belongs to an attempt that no longer exists. Finishing a flow the OS interrupted means handing the URL to `completeAuthorization({ callbackUrl })` yourself, with storage that survives the restart and within the authorization TTL.
