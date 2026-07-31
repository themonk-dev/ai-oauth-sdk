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
 * Comparison runs over a fixed span so a length difference does not change the
 * work done, with the length check folded into the accumulator rather than
 * returned early. Reads past the end substitute `0`, since `charCodeAt` would
 * otherwise return `NaN` and poison the XOR.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length)
  let difference = a.length ^ b.length

  for (let i = 0; i < length; i++) {
    const left = i < a.length ? a.charCodeAt(i) : 0
    const right = i < b.length ? b.charCodeAt(i) : 0
    difference |= left ^ right
  }

  return difference === 0
}
