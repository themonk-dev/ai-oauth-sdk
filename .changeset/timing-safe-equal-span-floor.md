---
'@ai-oauth-sdk/core': patch
---

Put a floor under `timingSafeEqual`'s comparison span, and describe what it actually guarantees.

The doc comment said "comparison runs over a fixed span so a length difference does not change the work done". The span was `Math.max(a.length, b.length)`, which is not fixed and does change with length: a one-character probe took about 5.2µs against a 1,000-character operand and about 480µs against a 100,000-character one, so the timing reported the other operand's length.

The contents were never leaked — every position is read and folded into the accumulator, and the timing is flat regardless of where two values first differ. Both call sites in this SDK compare a 43-character `state` whose length is public either way, so nothing shipped here was exploitable. It matters because `timingSafeEqual` is an exported primitive, documented as a general one, and people reach for those.

The span is now `Math.max(a.length, b.length, 128)`. Below the floor every comparison runs the same number of rounds, which takes the spread between a short and a 127-character second operand from roughly 28× down to under 4× — the remainder being only that a read past the end of a short operand is cheaper than a real `charCodeAt`. Above the floor the span still tracks the longer input, so a genuinely long secret still reveals that it is long. The comment now says that rather than the stronger thing it used to claim.

A floor, not a cap. A fixed span of 128 was the tempting version and is an authentication bypass: it makes any two values that agree on their first 128 characters compare equal. The tests pin a pair that differs only past that point, and 200 random pairs sharing a 128-character prefix, precisely to catch it. There is no behavioural change — the function was checked against `===` over 200,000 random pairs of length 0–300 with no disagreements.
