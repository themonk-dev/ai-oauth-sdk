import { describe, expect, it } from 'vitest'

import { parseStandardCallback } from '../src/providers/define.js'

/**
 * `response_mode=fragment` with `response_type=code` is legal, and is what
 * Entra/MSAL single-page apps use. No bundled provider asks for it, but
 * `defineProvider` and `providerFromDiscovery` exist precisely for the ones
 * this library has never heard of, and `extraAuthParams` lets an integrator
 * request it.
 *
 * The branch meant to support it could only ever fire for a bare `#code=…`
 * string, which nothing produces: every real caller hands in a whole URL —
 * `handleRedirectCallback` passes `window.location.href`, the React Native deep
 * link receiver passes the link, and `completeAuthorization` takes a
 * `callbackUrl`.
 */
describe('parseStandardCallback, fragment response mode', () => {
  it('reads a code out of the fragment of a full URL', () => {
    expect(parseStandardCallback('https://app.example/cb#code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    })
  })

  it('reads the fragment even when the query carries unrelated params', () => {
    expect(parseStandardCallback('https://app.example/cb?s=1#code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    })
  })

  it('reads the fragment of a custom-scheme deep link', () => {
    expect(parseStandardCallback('myapp://cb#code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    })
  })

  it('still reads a bare fragment string', () => {
    expect(parseStandardCallback('#code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('carries the error and its description out of a fragment', () => {
    expect(
      parseStandardCallback(
        'https://app.example/cb#error=access_denied&error_description=nope&state=S',
      ),
    ).toEqual({ error: 'access_denied', errorDescription: 'nope', state: 'S' })
  })
})

/**
 * The query stays authoritative. Reading the fragment is a fallback for when
 * the query carried no response at all, never an override.
 */
describe('parseStandardCallback, query response mode', () => {
  it('prefers a code in the query over anything in the fragment', () => {
    expect(parseStandardCallback('https://app.example/cb?code=real&state=S#code=decoy')).toEqual({
      code: 'real',
      state: 'S',
    })
  })

  it('prefers an error in the query over anything in the fragment', () => {
    expect(parseStandardCallback('https://app.example/cb?error=denied&state=S#code=decoy')).toEqual(
      { error: 'denied', state: 'S' },
    )
  })

  it('reads an ordinary query callback', () => {
    expect(parseStandardCallback('https://app.example/cb?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    })
  })

  it('reads a bare query string, with no punctuation at all', () => {
    expect(parseStandardCallback('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('reads a `?`-prefixed query string', () => {
    expect(parseStandardCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('returns nothing useful for a URL carrying no response', () => {
    expect(parseStandardCallback('https://app.example/cb')).toEqual({})
  })
})
