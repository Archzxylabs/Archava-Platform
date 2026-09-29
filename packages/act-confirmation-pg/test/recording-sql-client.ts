/**
 * A recording, in-memory `SqlClient` for the contract tests.
 *
 * It exists to make claims about this package's behaviour that nobody can make
 * about a real database in CI:
 *
 *   * **which SQL ran**, as text, so a test can assert that `consume` issued one
 *     conditional `UPDATE ... RETURNING` and not a `SELECT` followed by a write,
 *     and can assert that a tenant id goes in through a bound parameter instead
 *     of the statement text;
 *   * **what the parameters were**, positionally, so a test can prove a value
 *     was parameterized rather than escaped;
 *   * **what the database would have answered**, by replaying the predicate
 *     semantics itself: an insert that would collide with an existing id returns
 *     zero rows, and an `UPDATE` whose `WHERE` matches nothing returns zero
 *     rows, exactly as PostgreSQL does.
 *
 * The predicate is re-implemented here rather than assumed. That is the part
 * worth being careful about: if the fake answered "yes, spent" for any update,
 * the suite would prove only that the store can read a row back. By checking the
 * id, the tenant, the session, the action, both digests, the current state and
 * the supplied time against the stored row, the fake turns the difference
 * between `spent` and `already_consumed` into something the store has to earn.
 *
 * ## What this fake does NOT prove, and the suite says so in its own header
 *
 * This fake does not prove:
 *
 *   * that PostgreSQL accepts the SQL. The statements have not been parsed by a
 *     PostgreSQL server, which is why `scripts/verify-against-postgres.ts`
 *     applies the migration to one and why the Result names it.
 *   * that the primary key is actually enforced in a real database, or that two
 *     real processes racing one `consume` produce exactly one winner. The
 *     `Promise.all` test interleaves two callers in one process against a single
 *     `Map`; it proves the adapter never invents a second transition, not that a
 *     database serializes them. The fake is not concurrency.
 *   * durability across a restart, or that a transaction was atomic.
 */

import type { ConfirmationChallengeState } from '@archava/act-confirmation'
import type { SqlClient, SqlParameter, SqlRow, SqlStatement } from '@archava/act-storage'

/** A row as this package's migration stores it, in the fake's own vocabulary. */
export interface StoredChallenge {
  readonly id: string
  readonly tenantId: string
  readonly sessionId: string
  readonly actionId: string
  readonly tokenDigest: string
  readonly bindingDigest: string
  readonly state: ConfirmationChallengeState
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | null
}

export interface RecordingSqlClientOptions {
  /** Rows present before the first statement runs. */
  readonly seed?: readonly StoredChallenge[]
  /** Fail every call after this many successful calls. Default: never fail. */
  readonly failFromCall?: number
  /**
   * How `bigint`-shaped values come back. `pg` returns them as strings unless a
   * type parser is installed, so the store has to cope with both; the fake can
   * be either, and `postgres-challenge-store.test.ts` exercises both.
   */
  readonly readBigintsAs?: 'number' | 'string'
  /** A broken INSERT RETURNING response, independent of the row inserted. */
  readonly insertOutcome?: 'multiple_rows' | 'wrong_id' | 'malformed_row'
  /**
   * Answer the transition with something the predicate could not have produced.
   *
   * Each of these is impossible: `RETURNING` yields at most one row per primary
   * key, a row it returns satisfies every constraint the store wrote, and a
   * zero-row transition over a row that matches is a store bug. Forcing them
   * lets a test watch the store fail closed *without* a database that returns
   * them, which is the one thing no real PostgreSQL will do on request.
   *
   * `no_rows` fires even when the row matches, which is the case that matters:
   * the store is left holding a pending challenge it cannot have spent, and has
   * no way to say which of replay, mismatch or outage it was.
   */
  readonly updateOutcome?:
    | 'no_rows'
    | 'multiple_rows'
    | 'malformed_row'
    | 'pending_row'
    | 'wrong_tenant'
    | 'wrong_timestamp'
  /** Force the id-scoped classification lookup into an impossible answer. */
  readonly lookupOutcome?: 'multiple_rows' | 'malformed_row'
}

/**
 * The predicate of the conditional update, as a list of parameter positions.
 *
 * Written out rather than embedded in the answer so a reader can check the
 * store's binding order against the same table the store's `WHERE` clause uses.
 * If those two ever disagree, nothing in the fake would notice on its own.
 */
const UPDATE_PARAMETER = {
  id: 0,
  consumedAt: 1,
  tenantId: 2,
  sessionId: 3,
  actionId: 4,
  tokenDigest: 5,
  bindingDigest: 6,
  now: 7,
} as const

export class RecordingSqlClient implements SqlClient {
  readonly storeId = 'recording-sql-client'
  readonly capabilities = { transactions: false } as const

  private readonly rows = new Map<string, StoredChallenge>()
  private readonly failFromCall: number
  private readonly readBigintsAs: 'number' | 'string'
  private readonly insertOutcome?: 'multiple_rows' | 'wrong_id' | 'malformed_row'
  private readonly updateOutcome?: RecordingSqlClientOptions['updateOutcome']
  private readonly lookupOutcome?: 'multiple_rows' | 'malformed_row'
  private readonly recorded: SqlStatement[] = []
  private calls = 0

  constructor(options: RecordingSqlClientOptions = {}) {
    this.failFromCall = options.failFromCall ?? Infinity
    this.readBigintsAs = options.readBigintsAs ?? 'number'
    this.insertOutcome = options.insertOutcome
    this.updateOutcome = options.updateOutcome
    this.lookupOutcome = options.lookupOutcome
    for (const row of options.seed ?? []) this.rows.set(row.id, { ...row })
  }

  /** Every statement, in order, as the store built it. */
  get runs(): readonly SqlStatement[] {
    return this.recorded
  }

  /** The SQL text of every statement, in order. */
  get sql(): readonly string[] {
    return this.recorded.map((statement) => statement.sql)
  }

  get runCount(): number {
    return this.recorded.length
  }

  /** The one statement that must have run, or a loud refusal. */
  get only(): SqlStatement {
    const statement = this.recorded.at(0)
    if (statement === undefined) throw new Error('no_statement_recorded')
    return statement
  }

  /** The state of one challenge as the fake holds it. Read-only, never blocks. */
  inspect(id: string): StoredChallenge | undefined {
    const row = this.rows.get(id)
    return row === undefined ? undefined : { ...row }
  }

  /**
   * Records the statement, then answers it.
   *
   * The rejection is the fake's stand-in for a database error: `SqlClient`
   * promises resolve for "zero rows" and reject only when the answer is unknown,
   * and the store must treat the second as "nobody knows" rather than as "no".
   */
  run(statement: SqlStatement): Promise<readonly SqlRow[]> {
    this.recorded.push(statement)
    this.calls += 1
    if (this.calls > this.failFromCall) return Promise.reject(new Error('fake_sql_client_error'))
    return Promise.resolve(this.answer(statement))
  }

  private answer(statement: SqlStatement): readonly SqlRow[] {
    if (statement.sql.includes('INSERT INTO confirmation_challenges')) {
      return this.answerInsert(statement)
    }
    if (statement.sql.includes('UPDATE confirmation_challenges')) {
      return this.answerUpdate(statement)
    }
    if (statement.sql.includes('SELECT') && statement.sql.includes('WHERE id = $1')) {
      return this.answerLookup(statement)
    }
    throw new Error('fake_sql_client_unrecognised_statement')
  }

  /**
   * `ON CONFLICT (id) DO NOTHING`: an id that is already present inserts nothing
   * and returns no row. The call itself succeeds, because "this id is taken" is
   * an answer rather than a failure.
   */
  private answerInsert(statement: SqlStatement): readonly SqlRow[] {
    const [id, tenantId, sessionId, actionId, tokenDigest, bindingDigest, issuedAt, expiresAt] =
      statement.params
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('fake_sql_client_expected_a_challenge_id')
    }
    if (this.rows.has(id)) return []
    this.rows.set(id, {
      id,
      tenantId: text(tenantId),
      sessionId: text(sessionId),
      actionId: text(actionId),
      tokenDigest: text(tokenDigest),
      bindingDigest: text(bindingDigest),
      state: 'pending',
      issuedAt: milliseconds(issuedAt),
      expiresAt: milliseconds(expiresAt),
      consumedAt: null,
    })
    if (this.insertOutcome === 'multiple_rows') return [{ id }, { id }]
    if (this.insertOutcome === 'wrong_id') return [{ id: 'another-challenge' }]
    if (this.insertOutcome === 'malformed_row') return [{ id: null }]
    return [{ id }]
  }

  /**
   * The compare-and-swap. Everything in the predicate is checked against the
   * stored row, so a presentation that does not match spends nothing — which is
   * the whole point of putting the predicate in SQL rather than in the adapter.
   */
  private answerUpdate(statement: SqlStatement): readonly SqlRow[] {
    const { params } = statement
    const row = this.rows.get(text(params.at(UPDATE_PARAMETER.id)))

    const now = params.at(UPDATE_PARAMETER.now)
    const consumedAt = params.at(UPDATE_PARAMETER.consumedAt)
    const upperNow = params.at(8)
    // The store binds the transition stamp and the comparison time from the same
    // supplied instant. If they ever diverge, the record would claim it was spent
    // at a moment the predicate did not test.
    if (consumedAt !== now || now !== upperNow) {
      throw new Error('fake_sql_client_update_stamp_differs_from_comparison_time')
    }

    // Before the match, on purpose: `no_rows` is the case where a row *would*
    // have matched and the transition reported nothing anyway.
    const forced = this.forcedUpdate(statement, row)
    if (forced !== undefined) return forced

    if (row === undefined) return []

    const matches =
      row.tenantId === text(params.at(UPDATE_PARAMETER.tenantId)) &&
      row.sessionId === text(params.at(UPDATE_PARAMETER.sessionId)) &&
      row.actionId === text(params.at(UPDATE_PARAMETER.actionId)) &&
      row.tokenDigest === text(params.at(UPDATE_PARAMETER.tokenDigest)) &&
      row.bindingDigest === text(params.at(UPDATE_PARAMETER.bindingDigest)) &&
      row.state === 'pending' &&
      milliseconds(now) >= row.issuedAt &&
      milliseconds(upperNow) < row.expiresAt
    if (!matches) return []

    const spent: StoredChallenge = {
      ...row,
      state: 'consumed',
      consumedAt: milliseconds(consumedAt),
    }
    this.rows.set(spent.id, spent)
    return [this.toRow(spent)]
  }

  /** Scoped to the challenge id, so it can find another tenant's row and refuse. */
  private answerLookup(statement: SqlStatement): readonly SqlRow[] {
    const row = this.rows.get(text(statement.params.at(0)))
    if (this.lookupOutcome !== undefined) {
      if (row === undefined) {
        // The lookup reads back a row the fake does not hold. Inventing one from
        // an id would make the outcome depend on something the test never
        // planted, so the refusal is louder than the lie.
        throw new Error('fake_sql_client_forced_a_lookup_outcome_with_no_row')
      }
      return this.lookupOutcome === 'multiple_rows'
        ? [this.toRow(row), this.toRow(row)]
        : [this.malformedRow(row)]
    }
    return row === undefined ? [] : [this.toRow(row)]
  }

  private toRow(stored: StoredChallenge): SqlRow {
    return {
      id: stored.id,
      tenant_id: stored.tenantId,
      session_id: stored.sessionId,
      action_id: stored.actionId,
      token_digest: stored.tokenDigest,
      binding_digest: stored.bindingDigest,
      state: stored.state,
      issued_at: this.millis(stored.issuedAt),
      expires_at: this.millis(stored.expiresAt),
      consumed_at: stored.consumedAt === null ? null : this.millis(stored.consumedAt),
    }
  }

  private millis(value: number): number | string {
    return this.readBigintsAs === 'string' ? String(value) : value
  }

  /** `undefined` means "answer as the predicate would". */
  private forcedUpdate(
    statement: SqlStatement,
    row: StoredChallenge | undefined,
  ): readonly SqlRow[] | undefined {
    if (this.updateOutcome === undefined) return undefined
    if (this.updateOutcome === 'no_rows') return []
    const spent = row ?? this.spentFromPresentation(statement)
    if (this.updateOutcome === 'multiple_rows') return [this.toRow(spent), this.toRow(spent)]
    if (this.updateOutcome === 'malformed_row') return [this.malformedRow(spent)]
    if (this.updateOutcome === 'pending_row')
      return [this.toRow({ ...spent, state: 'pending', consumedAt: null })]
    if (this.updateOutcome === 'wrong_tenant')
      return [this.toRow({ ...spent, tenantId: 'another-tenant' })]
    if (this.updateOutcome === 'wrong_timestamp')
      return [
        this.toRow({
          ...spent,
          consumedAt: spent.consumedAt === null ? null : spent.consumedAt + 1,
        }),
      ]
    return undefined
  }

  /**
   * The row a transition of this presentation would have written, for a test
   * that never planted one. Fabricated from the parameters alone: the challenge
   * is issued and expired around the instant presented, which is the only
   * timeline the statement itself already asserts.
   */
  private spentFromPresentation(statement: SqlStatement): StoredChallenge {
    const { params } = statement
    const now = milliseconds(params.at(UPDATE_PARAMETER.now))
    return {
      id: text(params.at(UPDATE_PARAMETER.id)),
      tenantId: text(params.at(UPDATE_PARAMETER.tenantId)),
      sessionId: text(params.at(UPDATE_PARAMETER.sessionId)),
      actionId: text(params.at(UPDATE_PARAMETER.actionId)),
      tokenDigest: text(params.at(UPDATE_PARAMETER.tokenDigest)),
      bindingDigest: text(params.at(UPDATE_PARAMETER.bindingDigest)),
      state: 'consumed',
      issuedAt: now - 1,
      expiresAt: now + 1,
      consumedAt: now,
    }
  }

  /** A row that claims to be spent without saying when. The reader refuses it. */
  private malformedRow(stored: StoredChallenge): SqlRow {
    return { ...this.toRow(stored), state: 'consumed', consumed_at: null }
  }
}

function text(value: SqlParameter | undefined): string {
  return typeof value === 'string' ? value : ''
}

function milliseconds(value: SqlParameter | undefined): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  throw new Error('fake_sql_client_expected_milliseconds')
}
