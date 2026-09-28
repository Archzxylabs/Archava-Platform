/**
 * A recording, in-memory `SqlClient` for the contract tests.
 *
 * It exists to make claims about this package's behaviour that nobody can make
 * about a real database in CI:
 *
 *   * **which SQL ran**, as text, so a test can assert `INSERT ... ON CONFLICT`
 *     rather than `SELECT`-then-`INSERT`, and can assert that a tenant id goes
 *     in through a bound parameter instead of the statement text.
 *   * **what the parameters were**, positionally, so a test can prove a value
 *     was parameterized rather than escaped.
 *   * **what the database would have answered**, by replaying the constraint
 *     semantics itself: an insert that would collide with an existing
 *     `(tenant_id, action_kind, idempotency_key)` returns zero rows, exactly as
 *     PostgreSQL does.
 *
 * ## What this fake does NOT prove, and the suite says so in its own header
 *
 * This fake does not prove:
 *
 *   * that PostgreSQL accepts the SQL. The statements have not been parsed by
 *     a PostgreSQL server, which is why the "remaining database verification"
 *     section of the Result names `psql` and a real instance as the check.
 *   * that the unique constraint is actually enforced in a real database, and
 *     that two concurrent processes therefore cannot both win a claim. What it
 *     proves is the narrower, still-useful thing: that the adapter puts the
 *     uniqueness decision in a statement whose PostgreSQL semantics make it
 *     atomic, and that the adapter never retries an insert it lost.
 *   * any concurrency property of a real server. The fake is a single-threaded
 *     `Map`; a race test against it interleaves two `Promise`s in one process,
 *     which demonstrates that neither adapter invents a second insert — not
 *     that two real connections would be serialized. A real database is what
 *     makes that true, via the unique index this fake imitates.
 *   * durability. Nothing here survives the process, and no durability claim is
 *     made or implied by any test in this package.
 *
 * The imitated `ON CONFLICT DO NOTHING` semantics are the load-bearing part,
 * so they are implemented to match the documented behaviour rather than to make
 * tests pass: a conflicting insert yields an empty result set, and the row that
 * blocked it is left untouched.
 */

import type {
  RecordedRun,
  SqlParameter,
  RunOptions,
  SqlClient,
  SqlClientCapabilities,
  SqlRow,
  SqlStatement,
} from '../src/sql.js'

/** One stored attempt, in the fake's shape rather than the row shape. */
export interface StoredAttempt {
  readonly tenantId: string
  readonly actionKind: string
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly state: string
  readonly providerId: string | null
}

export interface RecordingSqlClientOptions {
  readonly storeId?: string
  readonly transactions?: boolean
  /** Rows the fake starts with, for replay and stale-settlement tests. */
  readonly seed?: readonly StoredAttempt[]
  /** Fail every call after this many successful calls. Default: never fail. */
  readonly failFromCall?: number
}

/**
 * A `SqlClient` that records every run and answers from a `Map`.
 *
 * The stored state is keyed by the composite identity, so a row belonging to
 * one tenant can never be produced for another tenant's key.
 */
export class RecordingSqlClient implements SqlClient {
  readonly storeId: string
  readonly capabilities: SqlClientCapabilities
  private readonly history: RecordedRun[] = []
  private readonly rows = new Map<string, StoredAttempt>()
  private calls = 0
  private readonly failFromCall: number

  constructor(options: RecordingSqlClientOptions = {}) {
    this.storeId = options.storeId ?? 'recording-sql-client'
    this.capabilities = { transactions: options.transactions ?? false }
    this.failFromCall = options.failFromCall ?? Infinity
    for (const row of options.seed ?? []) this.rows.set(keyOf(row), { ...row })
  }

  /** Every call that ran, in order. Readonly, because a test records history, not writes it. */
  get runs(): readonly RecordedRun[] {
    return this.history
  }

  /** The number of `run` calls made. */
  get runCount(): number {
    return this.history.length
  }

  /** The SQL that ran, in order. */
  get sql(): readonly string[] {
    return this.history.map((run) => run.sql)
  }

  /** Every call's parameters, in order. */
  get parameters(): readonly (readonly SqlParameter[])[] {
    return this.history.map((run) => run.params)
  }

  /** The only call made so far, for a test that asserts on a single statement. */
  get only(): RecordedRun {
    const run = this.history[0]
    if (run === undefined) throw new Error('no_statement_recorded')
    return run
  }

  /**
   * Record the call, then answer it or reject it.
   *
   * The promise form is not decoration: the port promises a rejection on a
   * database error, and `core.ts` handles that, so a fake that threw
   * synchronously would be testing a different client than the one it stands
   * in for.
   */
  run(statement: SqlStatement, options?: RunOptions): Promise<readonly SqlRow[]> {
    return new Promise<readonly SqlRow[]>((resolve, reject) => {
      this.history.push({
        sql: statement.sql,
        params: statement.params,
        transaction: options?.transaction ?? false,
      })
      this.calls += 1
      if (this.calls > this.failFromCall) {
        reject(new Error('fake_sql_client_error'))
        return
      }
      resolve(this.answer(statement))
    })
  }

  /** What the fake holds for an identity, or nothing. For assertions. */
  inspect(tenantId: string, actionKind: string, idempotencyKey: string): StoredAttempt | null {
    return this.rows.get(keyFor(tenantId, actionKind, idempotencyKey)) ?? null
  }

  /**
   * Answer as PostgreSQL would: an insert that collides returns nothing and
   * leaves the existing row alone; a conditional update that matches nothing
   * returns nothing and changes nothing.
   */
  private answer(statement: SqlStatement): readonly SqlRow[] {
    if (statement.sql.includes('INSERT INTO act_attempts')) return this.answerClaim(statement)
    if (statement.sql.includes('UPDATE act_attempts')) return this.answerSettle(statement)
    if (statement.sql.includes('SELECT')) return this.answerLookup(statement)
    throw new Error('fake_sql_client_unrecognised_statement')
  }

  private answerClaim(statement: SqlStatement): readonly SqlRow[] {
    const [tenantId, actionKind, idempotencyKey, fingerprint, openingState] = statement.params
    if (
      typeof tenantId !== 'string' ||
      typeof actionKind !== 'string' ||
      typeof idempotencyKey !== 'string'
    ) {
      throw new Error('fake_sql_client_expected_three_identity_parameters')
    }
    const identity = keyFor(tenantId, actionKind, idempotencyKey)
    if (this.rows.has(identity)) return []
    const stored: StoredAttempt = {
      tenantId,
      actionKind,
      idempotencyKey,
      fingerprint: text(fingerprint),
      state: text(openingState),
      providerId: null,
    }
    this.rows.set(identity, stored)
    return [toRow(stored)]
  }

  private answerSettle(statement: SqlStatement): readonly SqlRow[] {
    const identity = identityOf(statement)
    const [, , , fromState, toState, providerId] = statement.params
    const stored = this.rows.get(identity)
    if (stored === undefined || stored.state !== text(fromState)) return []
    const updated: StoredAttempt = {
      ...stored,
      state: text(toState),
      providerId: typeof providerId === 'string' ? providerId : null,
    }
    this.rows.set(identity, updated)
    return [toRow(updated)]
  }

  private answerLookup(statement: SqlStatement): readonly SqlRow[] {
    const stored = this.rows.get(identityOf(statement))
    return stored === undefined ? [] : [toRow(stored)]
  }
}

/**
 * The one attempt's key in the fake's table: the three identity parameters,
 * which every statement binds first and the unique index would be on.
 */
function keyFor(tenantId: string, actionKind: string, idempotencyKey: string): string {
  return `${tenantId} ${actionKind} ${idempotencyKey}`
}

/** Those three parameters as values, or a throw if the statement had none. */
function identityPartsOf(statement: SqlStatement): readonly [string, string, string] {
  const [tenantId, actionKind, idempotencyKey] = statement.params
  if (
    typeof tenantId !== 'string' ||
    typeof actionKind !== 'string' ||
    typeof idempotencyKey !== 'string'
  ) {
    throw new Error('fake_sql_client_expected_three_identity_parameters')
  }
  return [tenantId, actionKind, idempotencyKey]
}

/** The key for whatever identity this statement is about. */
function identityOf(statement: SqlStatement): string {
  const [tenantId, actionKind, idempotencyKey] = identityPartsOf(statement)
  return keyFor(tenantId, actionKind, idempotencyKey)
}

function text(value: SqlParameter | undefined): string {
  return typeof value === 'string' ? value : ''
}

function toRow(stored: StoredAttempt): SqlRow {
  return {
    tenant_id: stored.tenantId,
    action_kind: stored.actionKind,
    idempotency_key: stored.idempotencyKey,
    fingerprint: stored.fingerprint,
    state: stored.state,
    provider_id: stored.providerId,
  }
}

function keyOf(row: StoredAttempt): string {
  return keyFor(row.tenantId, row.actionKind, row.idempotencyKey)
}
