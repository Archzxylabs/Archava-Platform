/**
 * The store's one policy, written once.
 *
 * Both adapters — booking and email — need exactly the same three decisions
 * made the same way:
 *
 *   1. **A claim that won the insert is accepted.** `ON CONFLICT DO NOTHING` +
 *      `RETURNING` returned a row, which per PostgreSQL means the row was
 *      actually inserted and therefore that nobody else had this key.
 *   2. **A claim that lost the insert is a replay.** Zero rows means the unique
 *      constraint blocked this insert, so the key is already owned. The adapter
 *      then reads the existing row and hands back whoever owns it. The key is
 *      not retried and no row is overwritten.
 *   3. **A settlement that moved the row is settled; a settlement that matched
 *      zero rows is stale.** The record is no longer where the caller left it,
 *      and the caller is told that rather than being told "done".
 *
 * And one rule that outranks all three: **a database error is never an answer.**
 * A rejected promise from `run` — connection gone, constraint the statement did
 * not intend to hit, statement malformed, permission denied — comes out of this
 * module as `unavailable`, which is neither `accepted` nor `replayed`, neither
 * `settled` nor `stale`. It is the answer that lets the boundary above report
 * "nobody knows" and stop.
 *
 * That is the single most important property of this file. A store that
 * answered `accepted` on an error would let two processes both believe they had
 * claimed a key, and the boundary above would make two reservations. A store
 * that answered `settled` on an error would leave a record claiming a state
 * nobody wrote. Neither is a failure mode worth surviving cleverly: failing
 * closed is the job.
 */

import { claimStatement, lookupStatement, settleStatement } from './statements.js'
import { readAttemptRows } from './row.js'
import type { SqlClient, SqlRow } from './sql.js'

/**
 * What a store can honestly say about an attempt.
 *
 * The variants are deliberately not a success/failure pair. `unavailable` is
 * not a failure — it is the correct answer when nobody knows — and a
 * `malformed` row is not a failure either, it is a row that must not be
 * presented as a record.
 */
export type AttemptReading =
  /** This caller owns the attempt, and the row it inserted is what is described. */
  | { readonly status: 'claimed'; readonly row: AttemptRow }
  /** Somebody owns it already. This is that record. */
  | { readonly status: 'replayed'; readonly row: AttemptRow }
  /** The write landed, and the row as it now stands. */
  | { readonly status: 'settled'; readonly row: AttemptRow }
  /** The write did not land: the record is no longer in the state assumed. */
  | { readonly status: 'stale' }
  /** No row, which is an answer and not an error. Used by lookups only. */
  | { readonly status: 'empty' }
  /** The database would not answer. Nobody knows, and nothing may be assumed. */
  | { readonly status: 'unavailable' }
  /** A row came back and it does not check out. Never treated as `empty`. */
  | { readonly status: 'malformed'; readonly reason: string }

/** A validated row, in the vocabulary the store's callers use. */
export interface AttemptRow {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly state: string
  readonly providerId: string | null
}

/** The identity every attempt is filed under. */
export interface AttemptIdentity {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
}

/** Everything a claim needs. */
export interface ClaimAttempt extends AttemptIdentity {
  readonly fingerprint: string
  /** The boundary's spelling for "in flight": `in_flight` or `prepared`. */
  readonly openingState: string
}

/** Everything a settlement needs. */
export interface SettleAttempt extends AttemptIdentity {
  /** The state the caller believes the record is in. The compare half. */
  readonly fromState: string
  /** The state the record should become. The swap half. */
  readonly toState: string
  /** The identifier the authoritative system issued, or null if it issued none. */
  readonly providerId: string | null
}

/**
 * Attempt to make this key this caller's.
 *
 * One statement. There is no SELECT-then-INSERT, and no second call can be
 * interleaved between the check and the write because there is only one
 * operation. If the insert wins, the row is returned and the claim is this
 * caller's; if not, the statement returns nothing and the existing record is
 * read in a separate query.
 *
 * The read after a lost insert is the one place two statements touch the same
 * key. It is safe because it is a read: a losing claimer writes nothing, ever.
 */
export async function claimAttempt(
  client: SqlClient,
  attempt: ClaimAttempt,
): Promise<AttemptReading> {
  let rows: readonly SqlRow[]
  try {
    rows = await client.run(claimStatement(attempt))
  } catch {
    return { status: 'unavailable' }
  }
  const reading = readAttemptRows(rows, attempt)
  if (reading.status === 'record') return { status: 'claimed', row: toAttemptRow(reading) }
  if (reading.status === 'absent') return await replayedAttempt(client, attempt)
  return { status: 'malformed', reason: reading.reason }
}

/** Read the row that already owns this key. */
export async function lookupAttempt(
  client: SqlClient,
  identity: AttemptIdentity,
): Promise<AttemptReading> {
  let rows: readonly SqlRow[]
  try {
    rows = await client.run(lookupStatement(identity))
  } catch {
    return { status: 'unavailable' }
  }
  const reading = readAttemptRows(rows, identity)
  if (reading.status === 'record') return { status: 'replayed', row: toAttemptRow(reading) }
  if (reading.status === 'absent') return { status: 'empty' }
  return { status: 'malformed', reason: reading.reason }
}

/**
 * Move the record, but only if it is still where the caller left it.
 *
 * The compare-and-swap is in the statement's `WHERE`, not in JavaScript, which
 * is the whole point: a CAS implemented as a read followed by a decision
 * followed by a write is a race, and this store exists to close that race.
 */
export async function settleAttempt(
  client: SqlClient,
  settlement: SettleAttempt,
): Promise<AttemptReading> {
  let rows: readonly SqlRow[]
  try {
    rows = await client.run(settleStatement(settlement))
  } catch {
    return { status: 'unavailable' }
  }
  const reading = readAttemptRows(rows, settlement)
  if (reading.status === 'record') return { status: 'settled', row: toAttemptRow(reading) }
  if (reading.status === 'absent') return { status: 'stale' }
  return { status: 'malformed', reason: reading.reason }
}

/** Read the row a lost claim collided with. */
async function replayedAttempt(
  client: SqlClient,
  identity: AttemptIdentity,
): Promise<AttemptReading> {
  const reading = await lookupAttempt(client, identity)
  if (reading.status === 'replayed') return reading
  if (reading.status === 'empty') return { status: 'unavailable' }
  return reading
}

/** Map a validated reading into a validated row, longhand so no column drifts. */
function toAttemptRow(reading: {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly state: string
  readonly providerId: string | null
}): AttemptRow {
  return {
    tenantId: reading.tenantId,
    actionKind: reading.actionKind,
    idempotencyKey: reading.idempotencyKey,
    fingerprint: reading.fingerprint,
    state: reading.state,
    providerId: reading.providerId,
  }
}
