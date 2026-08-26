---
'@ai-oauth-sdk/core': patch
---

Trim base64 padding by scanning instead of with `/=+$/`, which backtracked quadratically on untrusted input.

`base64UrlDecode` normalised its input with `input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')`. The last of those is a greedy run anchored to the end of the string, so on a long run of `=` followed by any other character the engine retries the run from every successive start position and none of them reach the anchor. The cost is quadratic in the length of the run, and unbounded: measured through the public `decodeJwtPayload`, a 100KB JWT-shaped input blocked the event loop for about 7.6 seconds, with each doubling of the input costing four times as much.

This is reachable without doing anything unusual. `decodeJwtPayload` is called on `raw['id_token']` exactly as the token endpoint sent it — `providers/openai.ts`, `providers/gemini.ts` and `providers/xai.ts` all do — and nothing on that path bounds the length of the string first. `base64UrlDecode` and `decodeJwtPayload` are also both public exports, so an application decoding a token from anywhere else is on the same footing. A single response stalls the loop; the effect on a server handling callbacks is that one client hangs everything else.

Padding is now trimmed with a backwards scan, which is linear and allocates nothing at all when there is no padding to strip. `-` and `_` moved into the decode table alongside `+` and `/`, so the two alphabet-translation passes are gone as well and the whole function makes one pass over the input rather than four.

The output is unchanged, deliberately down to the shape of the array. Simply dropping the strip would have been the smaller diff and was wrong: the padding characters would have inflated the computed `byteLength`, so on roughly a third of inputs the function would start returning an over-allocated `subarray` where it used to return an exactly-sized array, and any caller reading `result.buffer` — `new Uint8Array(result.buffer)`, a hash over the backing store — would silently pick up trailing zeroes. The scan was checked against the previous implementation over 299,593 exhaustive strings, 60,000 random ones and 60,000 `Buffer` round-trips with no difference in content, length, byte offset or backing-store size.
