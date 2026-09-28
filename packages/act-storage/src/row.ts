/**
 * Reading a row back, without believing it.
 *
 * A row that comes out of PostgreSQL has been through a database, a driver and
 * a JSON or binary codec. None of those are the boundary that computed the
 * fingerprint, and none of them can vouch for what a row means. This file turns
 * a `SqlRow` into either a validated record or nothing at all, and the
 * difference between those two is the difference between a store answering and
 * a store guessing.
 *
 * Three rules, all of which lean the same way:
 *
 *   1. **A row that is not one of ours is refused, not repaired.** A `state`
 *      outside the known sets, a `provider_id` in a state that may not carry
 *      one, a tenant id that is not a non-empty string — each produces a
 *      refusal, meaning "this row is not a record I can report". Never a
 *      coercion, never a default.
 *   2. **Cross-tenant rows are detected, not ignored.** `readAttemptRow` takes
 *      the tenant and key it was asked about and refuses a row that answers a
 *      different one. A driver or a query that returned somebody else's record
 *      is a serious bug, and treating it as a miss would let one tenant's
 *      attempt answer another's.
 *   3. **A missing answer and a broken answer are distinguished.** The reader
 *      returns one of three things, and callers must not collapse them:
 *
 *      - `{ status: 'record', ... }` — a validated row.
 *      - `{ status: 'absent' }` — no row, which is what zero `RETURNING` rows
 *        means and is a normal answer.
 *      - `{ status: 'malformed', ... }` — there was a row and it does not check
 *        out. This is not `absent`. Presenting it as `absent` would let a caller
 *        conclude the key is free and claim it again.
 *
 * The third one is the one that keeps a bug from becoming a double booking: a
 * malformed row is louder than an empty result.
 */

import type { SqlRow } from './sql.js'

/** The four states a booking attempt row may hold. */
export const BOOKING_STATES = ['in_flight', 'confirmed', 'rejected', 'unknown'] as const

/** The four states an email attempt row may hold. */
export const EMAIL_STATES = ['prepared', 'accepted', 'rejected', 'unknown'] as const

/** Every state either boundary can write. One set, because one table holds both. */
export const ATTEMPT_STATES: ReadonlySet<string> = new Set([...BOOKING_STATES, ...EMAIL_STATES])

/** A state that may carry a provider identifier, per the schema's CHECK constraint. */
const STATES_WITH_PROVIDER_ID: ReadonlySet<string> = new Set(['confirmed', 'accepted'])

/** States that may not. */
const STATES_WITHOUT_PROVIDER_ID: ReadonlySet<string> = new Set([
  'in_flight',
  'prepared',
  'rejected',
  'unknown',
])

/** What reading one row produced. */
export type RowReading =
  | {
      readonly status: 'record'
      readonly tenantId: string
      readonly actionKind: string
      readonly idempotencyKey: string
      readonly fingerprint: string
      readonly state: string
      readonly providerId: string | null
    }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly reason: string }

/**
 * Turn the rows a statement returned into one reading.
 *
 * More than one row is itself a finding: the identity is unique by constraint,
 * so a second row for the same key means the constraint is not what this
 * package believes it is. That is a refusal, and it is reported rather than
 * quietly taking the first.
 */
export function readAttemptRows(
  rows: readonly SqlRow[],
  expected: {
    readonly tenantId: string
    readonly actionKind: string
    readonly idempotencyKey: string
  },
): RowReading {
  if (rows.length === 0) return { status: 'absent' }
  if (rows.length > 1) return { status: 'malformed', reason: 'multiple_rows_for_one_identity' }
  const first = rows[0]
  if (first === undefined) return { status: 'malformed', reason: 'row_unreadable' }
  return readAttemptRow(first, expected)
}

/** Turn one row into one reading, or refuse it. */
export function readAttemptRow(
  row: SqlRow,
  expected: {
    readonly tenantId: string
    readonly actionKind: string
    readonly idempotencyKey: string
  },
): RowReading {
  const tenantId = row['tenant_id']
  const actionKind = row['action_kind']
  const idempotencyKey = row['idempotency_key']
  const fingerprint = row['fingerprint']
  const state = row['state']
  const providerId = row['provider_id']

  // Identity first. A row that answers a different tenant, action or key than
  // the one asked about is not merely a malformed row — it is a cross-tenant
  // leak, and it is refused with a reason that names which.
  if (tenantId !== expected.tenantId) return { status: 'malformed', reason: 'tenant_mismatch' }
  if (actionKind !== expected.actionKind) {
    return { status: 'malformed', reason: 'action_kind_mismatch' }
  }
  if (idempotencyKey !== expected.idempotencyKey) {
    return { status: 'malformed', reason: 'idempotency_key_mismatch' }
  }

  if (!isNonEmptyString(tenantId)) return { status: 'malformed', reason: 'tenant_id_unusable' }
  if (!isNonEmptyString(actionKind)) return { status: 'malformed', reason: 'action_kind_unusable' }
  if (!isNonEmptyString(idempotencyKey)) {
    return { status: 'malformed', reason: 'idempotency_key_unusable' }
  }
  if (!isNonEmptyString(fingerprint)) return { status: 'malformed', reason: 'fingerprint_unusable' }
  if (!isNonEmptyString(state)) return { status: 'malformed', reason: 'state_unusable' }
  if (!ATTEMPT_STATES.has(state)) return { status: 'malformed', reason: 'state_unknown' }

  // The provider identifier is only present in the states that may carry one,
  // and only when it is a usable opaque id. A reference that is a number, an
  // object, an empty string or missing is not a reference, and a row asserting
  // one is not a record this package will report as a success.
  if (providerId !== null && providerId !== undefined) {
    if (!STATES_WITH_PROVIDER_ID.has(state)) {
      return { status: 'malformed', reason: 'provider_id_in_wrong_state' }
    }
    if (!isNonEmptyString(providerId)) {
      return { status: 'malformed', reason: 'provider_id_unusable' }
    }
  } else if (STATES_WITH_PROVIDER_ID.has(state)) {
    // A confirmed row with no reference is not a confirmation. The boundary
    // that asked will report unknown; that is the honest answer.
    return { status: 'malformed', reason: 'confirmed_state_without_provider_id' }
  } else if (!STATES_WITHOUT_PROVIDER_ID.has(state)) {
    return { status: 'malformed', reason: 'state_unclassified' }
  }

  return {
    status: 'record',
    tenantId,
    actionKind,
    idempotencyKey,
    fingerprint,
    state,
    providerId: providerId === null || providerId === undefined ? null : providerId,
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
