/**
 * The fixtures the confirmation tests run on.
 *
 * Every one of these is synthetic. Nothing here reaches a database, a provider,
 * a network or a real guest: the store is a Map that enforces the atomicity the
 * contract requires, the clock only moves when a test moves it, and the random
 * source is deterministic. That is what makes the assertions below assertions
 * about *this package's decisions* rather than about someone's infrastructure.
 *
 * Two of these fakes are deliberately *broken*, and they are the honest ones:
 *
 * - `ExpiredSpendStore` claims to have spent a challenge before the window it
 *   was minted with had opened.
 * - `UntimestampedStore` claims a spend with no consumption time at all.
 *
 * A store is allowed to be adversarial; the service is not entitled to believe it.
 * These two exist so that "the store said spent" is never taken for "spend it",
 * which is the difference between a contract and an incident.
 */

import { digestBinding, digestInputs, digestToken } from '../src/digest.js'
import type {
  ConfirmationChallengeConsumeResult,
  ConfirmationChallengeInsert,
  ConfirmationChallengeRecord,
  ConfirmationChallengeStore,
} from '../src/store.js'

/** The tenant, session, action and inputs every nominal case agrees on. */
export const TENANT = 'hotel-a'
export const SESSION = 'session-1'
export const ACTION = 'booking.create'
export const INPUTS = { room: 'deluxe', nights: 2 }

/** A tenant, an action and a payload that none of the above was minted for. */
export const OTHER_TENANT = 'hotel-b'
export const OTHER_SESSION = 'session-2'
export const OTHER_ACTION = 'booking.cancel'
export const OTHER_INPUTS = { room: 'deluxe', nights: 3 }

export const KEY = new Uint8Array(32).fill(1)
export const OTHER_KEY = new Uint8Array(32).fill(9)

/** A clock a test moves by hand, so no assertion here depends on wall time. */
export function fakeClock(at = 0) {
  let now = at
  return {
    now: () => now,
    advance: (by: number) => {
      now += by
      return now
    },
  }
}

/**
 * Deterministic bytes, different on every call.
 *
 * A constant is wrong here, and the failure it produces is instructive: with one
 * repeated 32-byte value, `newId` and `newChallengeToken` would return the same
 * hex string every mint, the store would treat the second issue as a duplicate id
 * and refuse it, and the service would look broken for a reason that has nothing
 * to do with the service. The same formula on the same counter would also make a
 * token literally contain its own challenge id.
 *
 * The counter gives what these tests need: identical sequences for identical test
 * runs, so an assertion written against one run holds for the next, and different
 * bytes for two calls inside one run, so two mints are two challenges.
 */
export function fakeRandom() {
  let counter = 0
  return (byteLength: number): Uint8Array => {
    counter += 1
    const bytes = new Uint8Array(byteLength)
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = (counter * 31 + index * 7 + 0xab) & 0xff
    }
    return bytes
  }
}

/**
 * Bytes that never vary, for the one test that needs to know what it asked for.
 */
export function constantRandom(fill: number): (byteLength: number) => Uint8Array {
  return (byteLength) => new Uint8Array(byteLength).fill(fill)
}

/**
 * A store that records what it was asked, and answers honestly.
 *
 * It enforces the one thing the contract requires of a store: `consume` is atomic,
 * so a challenge presented twice is spent once and the second presentation is
 * reported as already consumed. It does this with a Map and a synchronous
 * transition, which is enough here because there is no concurrency in-process —
 * and the tests say so, asserting the service asks the store exactly once rather
 * than asserting the Map is a database.
 */
export class RecordingStore implements ConfirmationChallengeStore {
  readonly storeId = 'recording'
  private readonly records = new Map<string, ConfirmationChallengeRecord>()
  private issueCount = 0
  private consumeCount = 0
  /** When set, the next `issue` reports that it could not record anything. */
  failNextIssue = false

  issue(insert: ConfirmationChallengeInsert): boolean {
    this.issueCount += 1
    if (this.failNextIssue) {
      this.failNextIssue = false
      return false
    }
    if (this.records.has(insert.id)) return false
    this.records.set(insert.id, {
      id: insert.id,
      tenantId: insert.tenantId,
      sessionId: insert.sessionId,
      actionId: insert.actionId,
      tokenDigest: insert.tokenDigest,
      bindingDigest: insert.bindingDigest,
      state: 'pending',
      issuedAt: insert.issuedAt,
      expiresAt: insert.expiresAt,
    })
    return true
  }

  consume(presentation: {
    id: string
    tenantId: string
    sessionId: string
    actionId: string
    tokenDigest: string
    bindingDigest: string
    now: number
  }): Promise<ConfirmationChallengeConsumeResult> {
    this.consumeCount += 1
    const record = this.records.get(presentation.id)
    if (record === undefined) return Promise.resolve({ status: 'not_found' })
    const matched =
      record.tenantId === presentation.tenantId &&
      record.sessionId === presentation.sessionId &&
      record.actionId === presentation.actionId &&
      record.tokenDigest === presentation.tokenDigest &&
      record.bindingDigest === presentation.bindingDigest
    if (!matched) return Promise.resolve({ status: 'mismatch' })
    // The atomic transition: a challenge that is not pending cannot be spent
    // again, whatever else has changed about the presentation.
    if (record.state !== 'pending') {
      return Promise.resolve({ status: 'already_consumed', challenge: record })
    }
    if (presentation.now >= record.expiresAt) {
      const expired: ConfirmationChallengeRecord = { ...record, state: 'expired' }
      this.records.set(record.id, expired)
      return Promise.resolve({ status: 'expired', challenge: expired })
    }
    const spent: ConfirmationChallengeRecord = {
      ...record,
      state: 'consumed',
      consumedAt: presentation.now,
    }
    this.records.set(record.id, spent)
    return Promise.resolve({ status: 'spent', challenge: spent })
  }

  stateOf(id: string): ConfirmationChallengeRecord | undefined {
    return this.records.get(id)
  }

  issues(): number {
    return this.issueCount
  }

  consumeCalls(): number {
    return this.consumeCount
  }
}

/**
 * A store that answers `spent`, with a record that passes every field the
 * service reconciles — and one lie inside it.
 *
 * The lies are what these two exist for. A store that answers `spent` has been
 * asked to spend something and says it did, and nothing in the transport carries
 * whether it did it *honestly*: the `consumedAt` can be before the challenge was
 * issued, or missing entirely. Both are impossible claims, and the service must
 * not act on either of them just because the store made it.
 *
 * Both take a token and build the digests the service will compute for the
 * matching presentation, so that the one thing standing between the store's
 * answer and a receipt is the lie itself and nothing else. That is the only way
 * the test below it tests something.
 */
class LyingStore implements ConfirmationChallengeStore {
  readonly storeId: string
  private readonly consumedAt: number | undefined

  constructor(
    storeId: string,
    private readonly token: string,
    consumedAt: number | undefined,
  ) {
    this.storeId = storeId
    this.consumedAt = consumedAt
  }

  consume(): Promise<ConfirmationChallengeConsumeResult> {
    return Promise.resolve({
      status: 'spent',
      // The `as` is the point: a committed record has this field, and a store
      // that answers `spent` without it is a store that has not done the thing
      // it claims. The cast is also the only way to build the shape in a test.
      challenge: {
        id: 'challenge-1',
        tenantId: TENANT,
        sessionId: SESSION,
        actionId: ACTION,
        tokenDigest: digestToken(KEY, this.token),
        bindingDigest: digestBinding(KEY, TENANT, SESSION, ACTION, digestInputs(KEY, INPUTS) ?? ''),
        state: 'consumed',
        issuedAt: 0,
        expiresAt: 300_000,
        ...(this.consumedAt === undefined ? {} : { consumedAt: this.consumedAt }),
      },
    })
  }

  /** Never minted through: these stores exist to be *presented* to, once. */
  issue(): boolean {
    return false
  }
}

/** A store that claims a spend with no consumption time, which is not a spend. */
export function untimestampedStore(token: string): ConfirmationChallengeStore {
  return new LyingStore('untimestamped', token, undefined)
}

/**
 * A store that claims a spend before the window it was minted with had opened.
 *
 * `consumedAt` of -1 is before `issuedAt` of 0, which is impossible, and is the
 * shape of a store whose transition ran against a different challenge's record
 * than the one it answered about.
 */
export function expiredSpendStore(token: string): ConfirmationChallengeStore {
  return new LyingStore('expired-spend', token, -1)
}

/** A store that cannot answer, which is never the same as answering no. */
export class ThrowingStore implements ConfirmationChallengeStore {
  readonly storeId = 'throwing'
  issue(): boolean {
    // Unavailable in both directions, and never a `false` that a caller could
    // read as "that id is taken".
    throw new Error('connection refused')
  }
  consume(): Promise<ConfirmationChallengeConsumeResult> {
    return Promise.reject(new Error('connection refused'))
  }
}

/**
 * A presentation that is right about everything except the token.
 *
 * `presentation` is the one the service minted, so the token being wrong is the
 * only difference and nothing else can be.
 */
export function otherTokenPresentation(
  presentation: ConfirmationPresentationShape,
): ConfirmationPresentationShape {
  return { ...presentation, token: 'f'.repeat(64) }
}

/** A presentation for another session that was never minted. */
export function otherSessionPresentation(
  presentation: ConfirmationPresentationShape,
): ConfirmationPresentationShape {
  return { ...presentation, sessionId: OTHER_SESSION }
}

/** A presentation for another action that was never minted. */
export function otherActionPresentation(
  presentation: ConfirmationPresentationShape,
): ConfirmationPresentationShape {
  return { ...presentation, actionId: OTHER_ACTION }
}

/** The same action, with one more night: a different agreement, not a typo of one. */
export function otherInputsPresentation(
  presentation: ConfirmationPresentationShape,
): ConfirmationPresentationShape {
  return { ...presentation, inputs: OTHER_INPUTS }
}

/** The shape of a presentation, before the service has seen it. */
interface ConfirmationPresentationShape {
  challengeId: string
  token: string
  tenantId: string
  sessionId: string
  actionId: string
  inputs: Readonly<Record<string, unknown>>
}
