---
'@ai-oauth-sdk/browser': patch
'@ai-oauth-sdk/react': patch
---

Match popup `postMessage` callbacks to the attempt, and stop a swapped `storage` serving the previous user's tokens

`popupReceiver` trusted any well-formed payload that passed its origin check, on the reasoning that
a `postMessage` reaches only the window that opened the popup. It does — but the popup was opened
under a fixed name, and a named auxiliary window is reachable by name from anywhere in its browsing
context group. A page the user arrived from could therefore navigate the live popup to the app's own
redirect page, which posts back from the app's own origin with the app's own window handle, and a
bare `?error=access_denied` cancelled whichever sign-in was in progress. `event.source` does not
separate the two, because a `WindowProxy` keeps its identity across navigation. The payload is now
matched to the attempt by `state`, as the `BroadcastChannel` path already was. A trailing fragment
artifact such as `#_=_` is not read as a different attempt — that callback still fails, at the
client, as `state_mismatch`; the tolerance only makes it fail by name instead of hanging to its
timeout. Because the comparison is exempt for a provider declaring `echoesState: false`, and so
gives that provider nothing, the popup is also opened under an unguessable, per-attempt window name
rather than a constant; a runtime with no `crypto.getRandomValues` to mint one is refused rather
than handed the old constant back. An explicit `windowName` is still honoured.

`useAuth` keyed its client on five options and captured the rest. `storage` is one of the captured
ones, and the client holds it for life, so an app that scopes storage per signed-in user and swaps
it kept the previous user's client — and went on serving that user's access *and* refresh token,
while never reading the new store. The memo key now covers every option that is plain data, plus a
new optional `storageKey` for the adapters it cannot inspect; the adapters themselves stay out of it
so an inline `memoryStorage()` cannot rebuild the client mid-login. A re-key also resets the hook's
state during render, so the swap cannot commit one frame of the previous user's tokens under the
client that replaced them. Changing `storage` while a session is held without re-keying warns once
in development.
