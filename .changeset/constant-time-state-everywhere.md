---
'@ai-oauth-sdk/browser': patch
'@ai-oauth-sdk/react-native': patch
---

Compare `state` in constant time in the popup and deep-link receivers, making the documented claim true.

`SECURITY.md` says, without qualification, that `state` is verified on every callback in constant time. `AuthClient` and `loopbackReceiver()` did that, with the `timingSafeEqual()` the core package already exports for it. `popupReceiver()` used `===` and the deep-link receiver used `!==`.

Neither is exploitable, and this is not presented as a fix for one. A `postMessage` and a `BroadcastChannel` are same-origin, a deep link is delivered in-process, and in both cases the client's own comparison — which was always constant time — runs again before anything is exchanged. The problem is the documentation: a guarantee stated flatly, with two of the four places that verify a `state` not meeting it, is a guarantee that is wrong. Making the code match is cheaper and more honest than adding the caveat.

`timingSafeEqual()` folds the length difference into its accumulator and substitutes `0` past the end of the shorter string, so every pair that compared equal before compares equal now, a missing `state` included.

One corner does change, and it is the one the receivers already shared with `loopbackReceiver()`: a callback carrying no `state` at all is now treated as equal to a presented `state` of `''`, where `===` called them different. `createAuthorization()` never mints an empty `state`, so `client.login()` cannot reach it; a caller passing `present('…?state=')` by hand can. This aligns the two receivers with the one that was always constant time rather than introducing anything new.
