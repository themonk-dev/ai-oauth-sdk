/**
 * Length-independent string comparison, for values an attacker supplies.
 *
 * `state` is compared against a value that arrives on the callback, i.e. from
 * outside. A plain `!==` short-circuits at the first differing character, which
 * in principle leaks how much of the value was correct and turns a 256-bit
 * guess into an incremental one.
 *
 * The practical risk here is low — an attacker also needs a usable `code`, and
 * the pending record is single-use — but the comparison is on the security
 * boundary and constant time costs nothing at these lengths.
 *
 * The work done is constant in the *contents* of both operands: every position
 * is read and folded into the accumulator, so where two values first differ
 * cannot be measured. The length check is folded in the same way rather than
 * returned early, and reads past the end substitute `0`, since `charCodeAt`
 * would otherwise return `NaN` and poison the XOR.
 *
 * Length is a weaker guarantee, and this is the honest statement of it. The
 * span used to be `max(a.length, b.length)` alone, under a comment claiming it
 * was fixed — so a one-character probe measured the length of whatever it was
 * compared against, taking microseconds against a short secret and hundreds of
 * microseconds against a long one. `MIN_SPAN` puts a floor under the iteration
 * count, which removes most of that: probes below the floor all run the same
 * number of rounds, and the remaining difference is only that a read past the
 * end of a short operand is cheaper than a real `charCodeAt`. Measured, the
 * spread between a short and a 127-character second operand falls from roughly
 * 28× to under 4×. Above the floor the span still tracks the longer input, so
 * a genuinely long secret still reveals that it is long.
 *
 * It has to be a floor and not a cap. Truncating the loop at a fixed 128 would
 * make any two values agreeing on their first 128 characters compare equal —
 * an authentication bypass, not a timing nicety — which is why the tests pin
 * a pair that differs only past that point.
 *
 * Both SDK call sites compare a 43-character `state` whose length is public
 * either way; the floor is here because this is an exported primitive that
 * others will reach for.
 */
const MIN_SPAN = 128

export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length, MIN_SPAN)
  let difference = a.length ^ b.length

  for (let i = 0; i < length; i++) {
    const left = i < a.length ? a.charCodeAt(i) : 0
    const right = i < b.length ? b.charCodeAt(i) : 0
    difference |= left ^ right
  }

  return difference === 0
}
