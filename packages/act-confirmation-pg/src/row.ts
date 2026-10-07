/**
 * Reading a row back, without believing it.
 *
 * A row that comes out of PostgreSQL has been through a database, a driver and a
 * JSON or binary codec. None of those are the boundary that computed the digests,
 * and none of them can vouch for what a row means. This file turns a `SqlRow`
 * into either a validated record or nothing at all, and the difference between
 * those two is the difference between a store answering and a store guessing.
 *
 * Three rules, all of which lean the same way.
 *
 *   1. **A row that is not one of ours is refused, not repaired.** A `state`
 *      outside the port's four, an instant that is not a whole number of
 *      milliseconds, a `consumed_at` that disagrees with the state, an id that is
 *      not a non-empty string — each produces a refusal, meaning "this row is not
 *      a record I can report". Never a coercion, never a default.
 *   2. **Rows that answer a different question are detected, not ignored.**
 *      `readChallengeRow` takes what was asked for and refuses a row that answers
 *      a different challenge. A driver or a query that returned somebody else's
 *      record is a serious bug, and treating it as a miss would let one
 *      challenge's verdict answer another's.
 *   3. **A missing answer and a broken answer are distinguished.** The reader
 *      returns one of three things, and callers must not collapse them:
 *
 *      - `{ status: 'record', ... }` — a validated row.
 *      - `{ status: 'absent' }` — no row, which is what zero `RETURNING` rows
 *        means and is a normal answer.
 *      - `{ status: 'malformed', ... }` — there was a row and it does not check
 *        out. This is not `absent`. Presenting it as `absent` would let a caller
 *        conclude a challenge never existed and ask again.
 *
 * The third is the one that matters most here, and it leans harder than it would
 * in the attempt stores: a confirmation is consent. A malformed row that reads as
 * "no such challenge" is a confirmation that fails to be recognized as already
 * spent, and the caller is left guessing which of the two happened.
 *
 * ## The one place this file is careful about types
 *
 * `issued_at`, `expires_at` and `consumed_at` are `bigint`, and `pg` returns
 * `bigint` as a string unless a type parser is configured. `readMilliseconds`
 * therefore accepts a number or a decimal string and refuses everything else —
 * including a float, a negative value, and a string that is not entirely digits.
 * `Number(value)` on a driver string would quietly turn an unexpected shape into
 * a plausible-looking instant, and a plausible-looking instant is the one kind of
 * wrong answer this store cannot detect later.
 */

import type {
  ConfirmationChallengeRecord,
  ConfirmationChallengeState,
} from '@archava/act-confirmation'
import type { SqlRow } from '@archava/act-storage'

export type ChallengeRowReading =
  | { readonly status: 'record'; readonly challenge: ConfirmationChallengeRecord }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly reason: string }

const CHALLENGE_STATES: ReadonlySet<string> = new Set<ConfirmationChallengeState>([
  'pending',
  'consumed',
  'expired',
  'revoked',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * A whole number of milliseconds, as either a `bigint` column would return it.
 *
 * Refuses a float, a negative value, and any non-decimal string. Because the
 * service's own arithmetic is integer milliseconds, a fractional instant here
 * means something upstream is not what this package thinks it is.
 *
 * Exported because the store checks the caller's supplied instant with it before
 * it spends anything, and that check has to be the same check a row gets.
 */
export function readMilliseconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** Zero rows is an answer. More than one is not: `id` is the primary key. */
export function readChallengeRows(rows: readonly SqlRow[], id: string): ChallengeRowReading {
  if (rows.length === 0) return { status: 'absent' }
  if (rows.length > 1) return { status: 'malformed', reason: 'multiple_rows_for_one_challenge' }
  const row = rows[0]
  if (row === undefined) return { status: 'malformed', reason: 'row_unreadable' }
  return readChallengeRow(row, id)
}

/** One text column, narrowed to a string or refuted. */
function readText(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null
}

/** The six text columns a challenge is identified by, or why one is not. */
function readIdentity(
  row: SqlRow,
  id: string,
):
  | {
      readonly status: 'record'
      readonly fields: {
        readonly challengeId: string
        readonly tenantId: string
        readonly sessionId: string
        readonly actionId: string
        readonly tokenDigest: string
        readonly bindingDigest: string
      }
    }
  | { readonly status: 'malformed'; readonly reason: string } {
  // Read one at a time and return on the first failure. A loop over column names
  // would read better and narrow nothing: TypeScript has no way to follow that
  // `row['tenant_id']` was checked under the name `tenant_id`, and a cast here
  // would be exactly the belief this file exists to withhold.
  const challengeId = readText(row.id)
  if (challengeId === null) return { status: 'malformed', reason: 'id_missing' }
  const tenantId = readText(row.tenant_id)
  if (tenantId === null) return { status: 'malformed', reason: 'tenant_id_missing' }
  const sessionId = readText(row.session_id)
  if (sessionId === null) return { status: 'malformed', reason: 'session_id_missing' }
  const actionId = readText(row.action_id)
  if (actionId === null) return { status: 'malformed', reason: 'action_id_missing' }
  const tokenDigest = readText(row.token_digest)
  if (tokenDigest === null) return { status: 'malformed', reason: 'token_digest_missing' }
  const bindingDigest = readText(row.binding_digest)
  if (bindingDigest === null) return { status: 'malformed', reason: 'binding_digest_missing' }

  if (challengeId !== id) return { status: 'malformed', reason: 'challenge_id_mismatch' }
  return {
    status: 'record',
    fields: { challengeId, tenantId, sessionId, actionId, tokenDigest, bindingDigest },
  }
}

/**
 * The state, narrowed to the port's four.
 *
 * A set membership test is not a type guard on its own, so the set is consulted
 * once here and the answer is a union member rather than a string the reader
 * would have to trust.
 */
function readState(value: unknown): ConfirmationChallengeState | null {
  if (typeof value !== 'string') return null
  return CHALLENGE_STATES.has(value) ? (value as ConfirmationChallengeState) : null
}

/** Validate one row, and refuse it if it answers a different challenge. */
export function readChallengeRow(row: SqlRow, id: string): ChallengeRowReading {
  const identity = readIdentity(row, id)
  if (identity.status !== 'record') return identity

  const { challengeId, tenantId, sessionId, actionId, tokenDigest, bindingDigest } = identity.fields

  const state = readState(row.state)
  if (state === null) return { status: 'malformed', reason: 'state_unknown' }

  const issuedAt = readMilliseconds(row.issued_at)
  const expiresAt = readMilliseconds(row.expires_at)
  if (issuedAt === null) return { status: 'malformed', reason: 'issued_at_unreadable' }
  if (expiresAt === null) return { status: 'malformed', reason: 'expires_at_unreadable' }
  if (expiresAt <= issuedAt) return { status: 'malformed', reason: 'window_not_positive' }

  // The migration ties these together in a CHECK constraint. The reader checks
  // them too, because the row in hand came from a database, not from the CHECK.
  const rawConsumedAt = row.consumed_at
  if (rawConsumedAt === null || rawConsumedAt === undefined) {
    if (state === 'consumed') {
      return { status: 'malformed', reason: 'consumed_without_an_instant' }
    }
    return {
      status: 'record',
      challenge: {
        id: challengeId,
        tenantId,
        sessionId,
        actionId,
        tokenDigest,
        bindingDigest,
        state,
        issuedAt,
        expiresAt,
      },
    }
  }

  if (state !== 'consumed') {
    return { status: 'malformed', reason: 'unstamped_state_carrying_an_instant' }
  }
  const consumedAt = readMilliseconds(rawConsumedAt)
  if (consumedAt === null) return { status: 'malformed', reason: 'consumed_at_unreadable' }
  if (consumedAt < issuedAt) return { status: 'malformed', reason: 'consumed_before_issued' }

  // Not checked here: `consumedAt < expiresAt`. That is the service's `reconcile`
  // to make, over the record, and a row stamped past its window is a record the
  // service refuses to mint a receipt from rather than one this reader discards.
  return {
    status: 'record',
    challenge: {
      id: challengeId,
      tenantId,
      sessionId,
      actionId,
      tokenDigest,
      bindingDigest,
      state,
      issuedAt,
      expiresAt,
      consumedAt,
    },
  }
}
