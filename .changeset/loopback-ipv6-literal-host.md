---
'@ai-oauth-sdk/node': patch
---

Stop `loopbackReceiver({ host: '::1' })` killing the process on its first request.

The request handler resolved the incoming path against a base built from the bind host: `new URL(request.url ?? '/', \`http://${bindHost}\`)`. A bare IPv6 literal is not a valid URL authority unqualified, so for `'::1'` that base is `http://::1` and the constructor throws `ERR_INVALID_URL`. It throws synchronously, inside a Node request handler, which is an `uncaughtException` — so the first request to such a receiver took the whole process down rather than failing a login.

Using `primaryHost` instead is not the fix, and it is worth saying why: `primaryHost` normalises only `'localhost'`, so for `'::1'` the two are the same string and the crash is identical.

Only `pathname` and `search` are ever read off that URL, so the authority was pure scaffolding to begin with. The base is now the constant `http://localhost`, with a comment at the call site saying that the host is deliberately constant because nothing reads it. Bracketing the literal would also have worked, and would have left a value in a position nothing looks at that still had to be got right.
