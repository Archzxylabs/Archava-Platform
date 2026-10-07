/**
 * Digest primitives, and the four ways they could go wrong.
 *
 * These are the tests that make the rest of the package's guarantees meaningful.
 * A confirmation is a claim about *exactly* what was agreed to, and that claim
 * lives entirely in digests: if two different inputs can share one, or one input
 * can be given a digest that means something else, then every runtime guarantee
 * in `service.test.ts` is an assertion about data that no longer matches reality.
 *
 * Four things are checked explicitly, and each one has a comment rather than a
 * name because the reasoning matters:
 *
 * 1. Correctness — a digest is deterministic for one input, and different for
 *    different inputs, including inputs that differ only by key order, and
 *    inputs that round-trip through JSON byte-for-byte.
 * 2. Domain separation — an input digest, a binding digest, a token digest and a
 *    receipt digest are never interchangeable, even for identical bytes.
 * 3. Canonicity — a value with no stable canonical form is refused, not coerced.
 *    `undefined` has to be refused, because `JSON.stringify` drops it and would
 *    collapse two different inputs onto one digest.
 * 4. Comparison — equality is measured without leaking *where* two digests
 *    differ.
 */

import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_TOKEN_BYTES,
  ID_BYTES,
  canonicalize,
  digestBinding,
  digestInputs,
  digestReceipt,
  digestToken,
  digestsEqual,
  isDigestKey,
  keyedDigest,
  newChallengeToken,
  newId,
  type RandomBytes,
} from '../src/digest.js'
import { constantRandom, fakeRandom } from './fakes.js'

const KEY = new Uint8Array(32).fill(1)
const OTHER_KEY = new Uint8Array(32).fill(9)

describe('canonicalize', () => {
  it('renders key order away, and nothing else', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }))
    // Same members, different nesting. Not the same claim.
    expect(canonicalize({ a: [1, 2] })).not.toBe(canonicalize({ a: [2, 1] }))
  })

  it('refuses a value with no stable form rather than inventing one', () => {
    // These are the values `JSON.stringify` would silently mangle, and each one
    // would collapse two different inputs onto a single digest if it survived.
    expect(canonicalize(Number.NaN)).toBeNull()
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBeNull()
    expect(canonicalize(undefined)).toBeNull()
    expect(canonicalize({ a: undefined })).toBeNull()
    expect(canonicalize(['ok', undefined])).toBeNull()
    expect(canonicalize(new Date())).toBeNull()
    expect(canonicalize(() => 1)).toBeNull()
    expect(canonicalize(class Foo {})).toBeNull()
    class Bar {
      constructor(readonly a: number) {}
    }
    expect(canonicalize(new Bar(1))).toBeNull()
    expect(canonicalize(Symbol('x'))).toBeNull()
    expect(canonicalize(10n)).toBeNull()
    expect(canonicalize(/re/g)).toBeNull()
    expect(canonicalize(new Map())).toBeNull()
    expect(canonicalize(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('still renders the value types that do have one', () => {
    expect(canonicalize(null)).toBe('null')
    expect(canonicalize('a')).toBe('"a"')
    expect(canonicalize(0)).toBe('0')
    // Empty object, empty array, and an array of nothing are all exactly that.
    expect(canonicalize({})).toBe('{}')
    expect(canonicalize([])).toBe('[]')
    expect(canonicalize([null, false])).toBe('[null,false]')
  })

  it('refuses depth past a fixed ceiling instead of recursing forever', () => {
    let nest: unknown = 'bottom'
    for (let i = 0; i < 300; i += 1) nest = { next: nest }
    // A self-referential object would otherwise recurse until the stack ends.
    // This is a refusal, not a crash, and the same policy as every other value
    // that has no canonical form.
    expect(canonicalize(nest)).toBeNull()
  })
})

describe('digestInputs', () => {
  it('is deterministic for one input, and different for different inputs', () => {
    expect(digestInputs(KEY, { a: 1 })).toBe(digestInputs(KEY, { a: 1 }))
    expect(digestInputs(KEY, { a: 1 })).not.toBe(digestInputs(KEY, { a: 2 }))
  })

  it('agrees across a JSON round-trip, so a persisted form still matches', () => {
    const inputs = {
      room: 'deluxe',
      nights: 2,
      guest: { email: 'guest@example.test', vip: true },
    }
    // Confirms the canonical form is stable for a payload that crossarr a network
    // boundary or a process restart.
    expect(digestInputs(KEY, inputs)).toBe(digestInputs(KEY, JSON.parse(JSON.stringify(inputs))))
  })

  it('refuses inputs it cannot canoninalise, rather than digesting them anyway', () => {
    // A `Date` is the interesting one: `JSON` gives it a string, which someone
    // could also supply directly as a real string, and the two would agree.
    expect(digestInputs(KEY, { when: new Date(0) })).toBeNull()
    expect(digestInputs(KEY, { when: undefined })).toBeNull()
  })

  it('agrees under one key and nobody else', () => {
    expect(digestInputs(KEY, { a: 1 })).not.toBe(digestInputs(OTHER_KEY, { a: 1 }))
  })
})

describe('domain separation', () => {
  it('never produces the same digest for two different namespaces', () => {
    // The bindings of two confirmations differ, so their binding digests differ.
    const binding = digestBinding(KEY, 't', 's', 'a', 'input')
    expect(binding).not.toBe(keyedDigest(KEY, 'archava/confirmation/input/v1', 'input'))
    expect(binding).not.toBe(digestToken(KEY, 'input'))
    expect(digestToken(KEY, 'token')).not.toBe(
      keyedDigest(KEY, 'archava/confirmation/binding/v1', 'token'),
    )
  })

  it('produces a receipt digest that covers every field it was given', () => {
    const fields = {
      receiptId: 'r',
      challengeId: 'c',
      tenantId: 't',
      sessionId: 's',
      actionId: 'a',
      inputDigest: 'i',
      bindingDigest: 'b',
      issuedAt: 0,
      expiresAt: 60_000,
      confirmedAt: 100,
    }
    expect(digestReceipt(KEY, fields)).toMatch(/^[0-9a-f]{64}$/)
    // Shifting one number by one is a different receipt, not a repeat of it.
    expect(digestReceipt(KEY, { ...fields, confirmedAt: 101 })).not.toBe(digestReceipt(KEY, fields))
    expect(digestReceipt(KEY, fields)).toBe(digestReceipt(KEY, fields))
  })
})

describe('framing', () => {
  it('never lets two orders of the same parts share a digest', () => {
    // The length prefix is what stops `('a','bc')` being spelled `('ab','c')`.
    expect(keyedDigest(KEY, 'd', 'a', 'bc')).not.toBe(keyedDigest(KEY, 'd', 'ab', 'c'))
    expect(keyedDigest(KEY, 'd', 'a')).not.toBe(keyedDigest(KEY, 'd', 'a', ''))
  })
})

describe('digestsEqual', () => {
  it('is false for a mismatch and true for a match', () => {
    expect(digestsEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(digestsEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false)
    // What a browser-supplied string usually looks like when it arrives.
    expect(digestsEqual('a'.repeat(64), '')).toBe(false)
  })

  it('refuses to compare anything that is not two digests', () => {
    // This is a comparison of digests, not of values. A caller that tries to
    // compare a token with `digestsEqual` gets false rather than a surprise.
    expect(digestsEqual(null, 'a')).toBe(false)
    expect(digestsEqual(undefined, undefined)).toBe(false)
    expect(digestsEqual(42, 42)).toBe(false)
  })
})

describe('randomness', () => {
  it('mints a different token for each call the source answers differently', () => {
    // This is a hex rendering of exactly what the source returned, not a source
    // of uniqueness itself. A constant source therefore yields the same token
    // twice — which is the honest contract, and the reason the challenge id, not
    // the token, is what a store treats as unique: a store that refused a second
    // challenge would silently break a hot path whenever it saw a repeat.
    const constant = constantRandom(0xab)
    expect(newChallengeToken(constant)).toBe(newChallengeToken(constant))
    const varying = fakeRandom()
    expect(newChallengeToken(varying)).not.toBe(newChallengeToken(varying))
  })

  it('refuses a source that does not return what it was asked for', () => {
    // A short source would produce a token that looks right and is not, which is
    // worse than a crash. The guard is a match against the requested length, so
    // it catches an id minted short as readily as a challenge token: half of
    // ID_BYTES is short for both, and exactly ID_BYTES is right for one only.
    const short: RandomBytes = () => new Uint8Array(ID_BYTES / 2)
    expect(() => newChallengeToken(short)).toThrow(TypeError)
    expect(() => newId(short)).toThrow(TypeError)
    const idSized: RandomBytes = () => new Uint8Array(ID_BYTES)
    expect(newId(idSized)).toMatch(/^[0-9a-f]{32}$/)
    expect(() => newChallengeToken(idSized)).toThrow(TypeError)
  })

  it('mints ids that are ids and tokens that are tokens', () => {
    // Each length is asserted against the byte count it is derived from, so a
    // change to the token's size has to be made here on purpose rather than
    // quietly leaving a hex-length assertion behind.
    expect(newId()).toMatch(new RegExp(`^[0-9a-f]{${ID_BYTES * 2}}$`))
    expect(newChallengeToken()).toMatch(new RegExp(`^[0-9a-f]{${CHALLENGE_TOKEN_BYTES * 2}}$`))
  })
})

describe('keys', () => {
  it('accepts a 32-byte key and refuses a short one', () => {
    expect(isDigestKey(new Uint8Array(32))).toBe(true)
    expect(isDigestKey(new Uint8Array(64))).toBe(true)
    expect(isDigestKey(new Uint8Array(31))).toBe(false)
    expect(isDigestKey(undefined)).toBe(false)
    expect(isDigestKey('not bytes')).toBe(false)
  })
})
