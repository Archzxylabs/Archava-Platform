/**
 * Digests, and the two things that make them safe to compare.
 *
 * A confirmation is a claim about *exactly* what was agreed to: this tenant, this
 * session, this action, and this set of validated inputs. Everything the runtime
 * stores, compares, logs or hands onward is a digest of that claim, because the
 * raw form of it — the guest's actual booking inputs — has no business in a store
 * row, a receipt or a trace.
 *
 * Three properties are load-bearing here, and each one has a test:
 *
 * 1. **A digest covers one thing.** Part of that is the domain tag — the input
 *    digest, the binding digest and the token digest are all HMAC-SHA256 under
 *    the same key, and they must never be interchangeable. A binding digest that
 *    could be passed off as an input digest would let a caller re-point one
 *    confirmation at another payload.
 *
 * 2. **Two different things never share a digest.** The canonical form is what
 *    makes this true for inputs: key order, and only key order, is normalised
 *    away. Anything that does not have a stable canonical form — `NaN`, a
 *    function, a `Date`, a class instance, a property whose value is `undefined`
 *    — is refused rather than coerced, because `JSON.stringify` silently drops
 *    `undefined` properties and coerces `Date` to a string, and either of those
 *    would let two different inputs digest the same.
 *
 * 3. **A comparison cannot be observed.** `digestsEqual` hashes both sides before
 *    comparing them, so the bytes it compares are always the same length whatever
 *    came in, and a mismatch cannot be timed into a guess about where the
 *    difference was. This matters for the token and the binding digest, both of
 *    which a visitor-supplied value is compared against.
 */

import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * How many random bytes a challenge token is.
 *
 * 256 bits, which is the same order of entropy a session id is expected to carry,
 * and is the number that makes guessing one online a lost cause rather than a
 * slow one. It is also why the token is 64 hex characters and nothing else.
 */
export const CHALLENGE_TOKEN_BYTES = 32

/** The shortest key a confirmation may be computed under. */
export const DIGEST_KEY_MIN_BYTES = 32

/** How many random bytes a challenge id or a receipt id is. */
export const ID_BYTES = 16

/**
 * A ceiling on what one digest will frame.
 *
 * Inputs reach this code already validated, so this is not a size check on
 * well-formed data — it is a ceiling that pays for itself the first time a
 * malformed payload arrives with a field wired to something unbounded.
 */
const MAX_FRAMED_BYTES = 1_048_576

/**
 * How deep a canonical form may nest before it is refused.
 *
 * A self-referential object would otherwise recurse until the stack ends. This
 * turns that into a refusal instead of a crash, which is the same policy used for
 * every other value that has no canonical form.
 */
const MAX_CANONICAL_DEPTH = 64

/**
 * The four namespaces.
 *
 * A digest is `HMAC(key, domain ‖ length-framed parts)`, and the domain is the
 * only thing standing between "the digest of these inputs" and "the digest of
 * this agreement". They are never equal, so neither can be substituted for the
 * other, so a challenge cannot be re-pointed at a payload it was not minted for.
 */
const INPUT_DOMAIN = 'archava/confirmation/input/v1'
const BINDING_DOMAIN = 'archava/confirmation/binding/v1'
const TOKEN_DOMAIN = 'archava/confirmation/token/v1'
const RECEIPT_DOMAIN = 'archava/confirmation/receipt/v1'

/**
 * The source of randomness, injectable so tests are deterministic.
 *
 * `node:crypto`'s is the right production answer; the only reason this is a
 * parameter is that a test which cannot reproduce a token cannot make an
 * assertion about two of them being different.
 */
export type RandomBytes = (byteLength: number) => Uint8Array

/**
 * The server-side key every digest in a confirmation is computed under.
 *
 * A deployment secret that must survive a restart: a reconciliation computed
 * under yesterday's key agrees with nothing issued today, which is the correct
 * failure — a stale key invalidates old challenges rather than validating new
 * ones against stale ones.
 */
export type DigestKey = Uint8Array

export const defaultRandomBytes: RandomBytes = (byteLength) =>
  new Uint8Array(nodeRandomBytes(byteLength))

function isBytes(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array || Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

/**
 * Whether a value is usable as a digest key: bytes, and at least 256 of them.
 *
 * A shorter key is a weaker digest, and the difference between a 16-byte and a
 * 32-byte key is not something a configuration file should be able to decide by
 * accident.
 */
export function isDigestKey(value: unknown): value is DigestKey {
  return isBytes(value) && value.length >= DIGEST_KEY_MIN_BYTES
}

/**
 * A stable string for any value that has one, or `null` for any that does not.
 *
 * The rules, in the order they matter:
 *
 * - Keys are sorted, so `{room, nights}` and `{nights, room}` agree. Nothing else
 *   about an object's identity is normalised away.
 * - `undefined` anywhere — as a value, in an object property, or in an array — is
 *   a refusal rather than an omission, because a property present with the value
 *   `undefined` and a property that is not there are different claims, and the
 *   default JSON behaviour of dropping the first would collapse them.
 * - A class instance is a refusal. Flattening one to its public fields would mean
 *   a `Date`, a `RegExp` and a future wrapper object all canonicalise to strings
 *   that other values also canonicalise to.
 * - Non-finite numbers are refusals for the same reason: `JSON.stringify` renders
 *   `NaN` as `null`, which is a value that already exists.
 */
export function canonicalize(value: unknown): string | null {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): string | null {
  if (depth > MAX_CANONICAL_DEPTH) return null
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : null
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      return serializeObject(value, depth)
    // `bigint` throws in JSON.stringify, a function and a symbol have no stable
    // representation, and any future type lands here rather than silently
    // acquiring one.
    case 'bigint':
    case 'symbol':
    case 'undefined':
      return null
    default:
      return null
  }
}

function serializeObject(value: object, depth: number): string | null {
  // Raw bytes are not a value to digest: they canonicalise, if they canonicalise
  // at all, to an object of numeric keys that other objects can also spell.
  if (isBytes(value)) return null
  if (Array.isArray(value)) return serializeArray(value as readonly unknown[], depth)
  // The prototype check is what refuses a Date, a Map, a Set and every class
  // instance in one line, and what still admits a plain object literal or an
  // object created with no prototype.
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  const fields: string[] = []
  for (const key of Object.keys(value).sort()) {
    const field = serialize((value as Record<string, unknown>)[key], depth + 1)
    if (field === null) return null
    fields.push(`${JSON.stringify(key)}:${field}`)
  }
  return `{${fields.join(',')}}`
}

function serializeArray(value: readonly unknown[], depth: number): string | null {
  const fields: string[] = []
  for (const element of value) {
    const field = serialize(element, depth + 1)
    if (field === null) return null
    fields.push(field)
  }
  return `[${fields.join(',')}]`
}

/**
 * `HMAC-SHA256` over a domain and some parts, as lowercase hex.
 *
 * Each part is length-prefixed before it is hashed, which is what stops
 * `['a', 'b']` and `['ab', '']` from being the same message — the very first
 * thing a separator-free join gets wrong.
 */
export function keyedDigest(key: DigestKey, domain: string, ...parts: readonly string[]): string {
  const message = frame([domain, ...parts])
  const hmac = createHmac('sha256', key)
  hmac.update(message)
  return hmac.digest('hex')
}

function frame(parts: readonly string[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let size = 0
  for (const part of parts) {
    const bytes = encoder.encode(part)
    size += 4 + bytes.length
    if (size > MAX_FRAMED_BYTES) {
      throw new RangeError('a confirmation digest cannot frame more than 1 MiB')
    }
    chunks.push(lengthHeader(bytes.length), bytes)
  }
  return concat(chunks, size)
}

function lengthHeader(size: number): Uint8Array {
  const header = new Uint8Array(4)
  const view = new DataView(header.buffer)
  view.setUint32(0, size, false)
  return header
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

/** The digest of the inputs themselves, under the input domain. */
export function digestInputs(key: DigestKey, inputs: unknown): string | null {
  const form = canonicalize(inputs)
  if (form === null) return null
  return keyedDigest(key, INPUT_DOMAIN, form)
}

/**
 * The digest binding a challenge to exactly what it is about.
 *
 * All four parts are load-bearing, and dropping any one of them makes the
 * challenge reusable across it: without the action id, a confirmation for
 * `booking.create` would be a confirmation for `booking.cancel`.
 */
export function digestBinding(
  key: DigestKey,
  tenantId: string,
  sessionId: string,
  actionId: string,
  inputDigest: string,
): string {
  return keyedDigest(key, BINDING_DOMAIN, tenantId, sessionId, actionId, inputDigest)
}

/**
 * The digest of the token, as the store holds it.
 *
 * This is the one thing a store is entitled to keep. The raw token is returned to
 * the caller once, delivered by the caller to whoever is confirming, and appears
 * only here as a digest from then on.
 */
export function digestToken(key: DigestKey, token: string): string {
  return keyedDigest(key, TOKEN_DOMAIN, token)
}

/** The receipt fields a receipt digest covers. */
export interface ReceiptFields {
  readonly receiptId: string
  readonly challengeId: string
  readonly tenantId: string
  readonly sessionId: string
  readonly actionId: string
  readonly inputDigest: string
  readonly bindingDigest: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly confirmedAt: number
}

/**
 * The digest of a receipt, for a host that needs to log or correlate one.
 *
 * This is what a trace is allowed to carry. It carries every fact about the
 * agreement and none of the input, which is the whole reason a receipt has a
 * digest and not a payload.
 */
export function digestReceipt(key: DigestKey, fields: ReceiptFields): string {
  return keyedDigest(
    key,
    RECEIPT_DOMAIN,
    fields.receiptId,
    fields.challengeId,
    fields.tenantId,
    fields.sessionId,
    fields.actionId,
    fields.inputDigest,
    fields.bindingDigest,
    String(fields.issuedAt),
    String(fields.expiresAt),
    String(fields.confirmedAt),
  )
}

/**
 * Whether two digests are equal, without leaking where they differ.
 *
 * Both sides are hashed first, so the comparison is over two fixed-length buffers
 * whatever came in. That is what makes `timingSafeEqual` applicable at all: a
 * direct comparison of two hex strings of differing length would return early on
 * the length check and short-circuit the rest, which is a measurable difference.
 */
export function digestsEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return timingSafeEqual(digestForComparison(left), digestForComparison(right))
}

/** A fixed-size, non-reversible rendering of a digest for comparison. */
function digestForComparison(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest())
}

/**
 * A fresh challenge token: 256 bits of randomness as 64 lowercase hex characters.
 *
 * The source must return exactly `CHALLENGE_TOKEN_BYTES`. A source that returned
 * fewer would produce a token that looks right and is not, which is worse than a
 * crash, so this refuses rather than padding.
 */
export function newChallengeToken(source: RandomBytes = defaultRandomBytes): string {
  const bytes = source(CHALLENGE_TOKEN_BYTES)
  if (!isBytes(bytes) || bytes.length !== CHALLENGE_TOKEN_BYTES) {
    throw new TypeError(`a challenge token needs ${CHALLENGE_TOKEN_BYTES} random bytes`)
  }
  return toHex(bytes)
}

/** A challenge or receipt id: 128 bits, which is enough to never collide. */
export function newId(source: RandomBytes = defaultRandomBytes): string {
  const bytes = source(ID_BYTES)
  if (!isBytes(bytes) || bytes.length !== ID_BYTES) {
    throw new TypeError(`an id needs ${ID_BYTES} random bytes`)
  }
  return toHex(bytes)
}

const HEX = '0123456789abcdef'

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += HEX[byte >> 4] ?? '0'
    hex += HEX[byte & 0x0f] ?? '0'
  }
  return hex
}
