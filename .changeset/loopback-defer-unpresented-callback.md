---
'@ai-oauth-sdk/node': patch
---

Hold a loopback callback that arrives before the attempt is known, instead of accepting it as ours.

`loopbackReceiver()` learns the `state` it will judge callbacks by in `present()`, and binds the port in `start()`. Those are not the same moment. `login()` does real asynchronous storage I/O between them — it writes the pending record with the PKCE verifier — and for that entire interval the server was listening with `presentedState` still undefined, which `belongsToThisAttempt()` short-circuits to "yes, ours".

Two of the bundled providers bind fixed, published loopback ports: OpenAI 1455, xAI 56121. So a page the user already had open could top-level-navigate to `http://127.0.0.1:1455/callback?error=access_denied` and, if it landed in that window, have the callback taken. A navigation carries `Sec-Fetch-Dest: document`, so the fetch-metadata check passes it by design — it cannot tell the provider's own redirect from a page navigating the user to the same URL, which is exactly why the `state` comparison exists. Settling that denial rejects `wait()` and closes the server: the user's login dies, and the window is one an attacker can simply keep retrying until they hit it.

The guard defers rather than refuses, and that distinction is the whole design. Refusing an unpresented callback would break a caller that drives `start()` and opens the browser itself, which is supported. So a request for the callback path waits for whichever comes first: `present()`, which `login()` always calls before `wait()`, or the first `wait()`, which is where a direct driver declares its setup finished. Either way the callback is then evaluated against something real. A direct driver is held for a moment and never turned away, and what decides a callback is now what the caller did rather than how fast a disk was.

Requests for another path, another method, or ones the fetch-metadata check refuses are answered immediately, since none of them can touch the pending callback and holding them would hang a caller that never presents at all.

The deep-link and popup receivers hold the same flag and use it the other way round — they drop an unpresented payload outright. The difference is what the channel is: theirs exists before the flow does, so anything early is somebody else's by construction, while a bound port does not exist until `start()` binds it and an early callback there may well be ours.
