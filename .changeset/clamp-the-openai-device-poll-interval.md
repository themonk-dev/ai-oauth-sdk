---
'@ai-oauth-sdk/core': patch
---

Clamp `interval` and `expires_at` in the OpenAI device flow, as the RFC 8628 flow already clamps its own pair.

Both values come from the server and were taken as sent. An `interval` at or below zero fell back to five seconds, but anything above zero did not: `"0.001"` is a valid response and turned the poll loop into an unthrottled flood of an OpenAI endpoint, from every client that received it, until the deadline. And `expires_at` is an absolute timestamp rather than a duration, so a far-future one held that loop open for as long as it named.

The interval is now bounded to between one and sixty seconds, with the same five-second fallback, and the deadline is capped a day out. There is still no floor on the deadline — a short one simply ends the loop, which is the server's call to make, and the sibling flow says so too.

The bound is a bound and not a rewrite: a server behaving normally still sees its own numbers used. OpenAI sends `interval` as a string, unlike everywhere else, so the coercion happens before the clamp rather than after — clamping the raw string would read every real response as absent and quietly substitute the fallback, which would look like the bound working while the server's value was never honoured at all.
