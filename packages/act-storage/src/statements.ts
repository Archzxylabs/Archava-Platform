/**
 * The two statements these stores run, and the row reader that refuses to
 * believe anything a database said.
 *
 * There are deliberately only two. Everything the boundaries need from
 * durability is expressible as:
 *
 *   1. **claim** — "make this key mine, or tell me who owns it". One statement,
 *      because a claim that is two statements is a claim two processes can both
 *      win.
 *   2. **settle** — "if it is still in the state I last saw, move it to this
 *      one". One statement, because a conditional update is what makes the
 *      compare-and-swap a single step rather than a read that races a write.
 *
 * ## What the statements are, and why each part is there
 *
 * ### claim
 *
 * ```sql
 * INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)
 * VALUES ($1, $2, $3, $4, $5)
 * ON CONFLICT DO NOTHING
 * RETURNING tenant_id, action_kind, idempotency_key, fingerprint, state, provider_id
 * ```
 *
 * `ON CONFLICT DO NOTHING` avoids inserting a row as its alternative action, and
 * for `DO NOTHING` it is optional to specify a conflict target — conflicts with
 * all usable constraints and unique indexes are handled. `RETURNING` computes
 * values based on each row actually inserted, and only rows that were
 * successfully inserted are returned. So: zero rows means somebody else owns the
 * key, and the answer is a refusal, never an error and never a second insert.
 * This is why a `SELECT` is never needed on that path — the insert is the test.
 *
 * `DO NOTHING` with no conflict target is the right choice here rather than
 * naming `(tenant_id, action_kind, idempotency_key)`: it covers the primary key
 * whichever constraint fires, and the table has exactly one useful arbiter. If
 * a later migration adds a second unique constraint, the claim stays correct
 * instead of raising an error this adapter would have to classify.
 *
 * ### settle
 *
 * ```sql
 * UPDATE act_attempts
 *    SET state = $n, provider_id = $n, settled_at = now()
 *  WHERE tenant_id = $1 AND action_kind = $2 AND idempotency_key = $3
 *    AND state = $4
 * RETURNING tenant_id, action_kind, idempotency_key, fingerprint, state, provider_id
 * ```
 *
 * `RETURNING` computes values over each row actually updated, so a `WHERE` that
 * matches nothing produces an empty result set, and zero rows updated is not an
 * error. The `WHERE` is the compare-and-swap: only the process that still sees
 * the state it left the record in may move it. A late reconciliation that loses
 * the race gets zero rows, which is "the record changed under you" — an answer,
 * not a failure.
 *
 * Every identifier in both `WHERE` clauses is a bound parameter. There is no
 * path by which a tenant id can become statement text.
 *
 * ## What is read back, and what is not
 *
 * `RETURNING` is asked for the six columns the ports need and for exactly those
 * six. Not `claimed_at`, not `settled_at`, not anything a later migration might
 * add. A row this reader does not recognise is not presented as a record — see
 * `readAttemptRow`.
 */

import type { SqlStatement } from './sql.js'

/** The columns both statements return, in the order both statements return them. */
export const ATTEMPT_COLUMNS = [
  'tenant_id',
  'action_kind',
  'idempotency_key',
  'fingerprint',
  'state',
  'provider_id',
] as const

const COLUMN_LIST = ATTEMPT_COLUMNS.join(', ')

/**
 * Make this key this caller's, or find out who already owns it.
 *
 * The identity is four bound parameters and the state is the fifth; the state
 * written here is the boundary's "in flight" spelling (`in_flight` for booking,
 * `prepared` for email) and is passed in rather than hard-coded, so this
 * function does not know which boundary is asking.
 */
export function claimStatement(params: {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly openingState: string
}): SqlStatement {
  return {
    sql: `INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
          RETURNING ${COLUMN_LIST}`,
    params: [
      params.tenantId,
      params.actionKind,
      params.idempotencyKey,
      params.fingerprint,
      params.openingState,
    ],
  }
}

/**
 * Find out who owns this key, without attempting to take it.
 *
 * A `SELECT`, used only after a zero-row claim. It is the only place the
 * adapters read a row they did not insert, which is why its result goes through
 * `readAttemptRow` too.
 */
export function lookupStatement(params: {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
}): SqlStatement {
  return {
    sql: `SELECT ${COLUMN_LIST}
          FROM act_attempts
          WHERE tenant_id = $1 AND action_kind = $2 AND idempotency_key = $3`,
    params: [params.tenantId, params.actionKind, params.idempotencyKey],
  }
}

/** What a settlement writes, in the order the statement binds them. */
export interface SettlementStatementParams {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
  /** The state the caller believes the record is still in. The CAS guard. */
  readonly fromState: string
  /** The state it should become. */
  readonly toState: string
  /** The opaque id the authoritative system issued, or null if there is none. */
  readonly providerId: string | null
}

/**
 * Move the record, but only if it is still where the caller left it.
 *
 * `fromState` is the fourth parameter and appears in the `WHERE`, not the
 * `SET`. A late reconciliation that arrives after the record has already become
 * `confirmed` must not be able to overwrite that with its own answer, and this
 * is the line that stops it: it matches zero rows and is told so.
 */
export function settleStatement(params: SettlementStatementParams): SqlStatement {
  return {
    sql: `UPDATE act_attempts
             SET state = $5, provider_id = $6, settled_at = now()
           WHERE tenant_id = $1 AND action_kind = $2 AND idempotency_key = $3
             AND state = $4
           RETURNING ${COLUMN_LIST}`,
    params: [
      params.tenantId,
      params.actionKind,
      params.idempotencyKey,
      params.fromState,
      params.toState,
      params.providerId,
    ],
  }
}
