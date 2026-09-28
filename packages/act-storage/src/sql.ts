/**
 * The database seam this package talks to.
 *
 * Everything in `@archava/act-storage` runs through this interface. It exists
 * so that:
 *
 *   * this package does not depend on a driver. No `pg`, no `postgres`, no
 *     `@neondatabase/serverless` — the deployment brings its own, and the choice
 *     is a deployment decision this package has no business making.
 *   * the tests can be a recording fake, so "is this SQL parameterized?" is a
 *     question about recorded calls rather than a claim about a real database
 *     nobody in CI has credentials for.
 *   * a tenant id can never be interpolated into a statement. It cannot be:
 *     the interface has no method that takes a whole statement.
 *
 * **This is one connection's worth of statements, not a transaction manager.**
 * `RunOptions.transaction` is a grouping request: an adapter that honours it
 * runs the statement inside a transaction, and one that cannot says so rather
 * than silently running it outside one. See `transaction.ts` for why the
 * adapters are written so that losing the transaction does not lose the
 * guarantee.
 */

/** A value a bound parameter may hold. Nothing tenant-supplied except through the boundary's own fields. */
export type SqlParameter = string | number | boolean | null

/**
 * One SQL statement, already parameterized.
 *
 * `sql` carries the statement text with `$1`, `$2`, … placeholders — never a
 * value. `params` carries the values, positionally, in the same order. The
 * adapter in this package never builds a parameter by string concatenation,
 * which is why a tenant id cannot be smuggled into a statement: the only thing
 * it could produce is a `$n` placeholder.
 */
export interface SqlStatement {
  readonly sql: string
  readonly params: readonly SqlParameter[]
}

/** One row as the client returns it. Values are untrusted input. */
export type SqlRow = Readonly<Record<string, unknown>>

/** How a statement should be run. */
export interface RunOptions {
  /**
   * Ask for a transaction.
   *
   * A `claim` is one statement and an atomic operation in its own right, so it
   * cannot lose atomicity here. A `settle` is one conditional statement too.
   * Transactions matter for a future caller that wants read-then-write to be
   * one step; asking for it here keeps that door open without the adapters
   * depending on a driver's transaction API.
   */
  readonly transaction?: boolean
}

/** What a client says it can do. */
export interface SqlClientCapabilities {
  /** Whether `RunOptions.transaction` is honoured or ignored. */
  readonly transactions: boolean
  /** The migration this client's schema is expected to be at, if it knows. */
  readonly migration?: string
}

/**
 * The injected database client.
 *
 * `storeId` is the audit-trail name the boundary composes into its own — not a
 * secret, and deliberately a client-supplied string so the test fake can name
 * itself without pretending to be a database.
 */
export interface SqlClient {
  readonly storeId: string
  readonly capabilities: SqlClientCapabilities
  /**
   * Run one parameterized statement.
   *
   * The promise rejects on a database error — a connection that dropped, a
   * constraint the statement did not intend to hit, a malformed statement. It
   * does not reject for "zero rows", because zero rows is an answer and not a
   * failure. Callers must treat a rejection as "nobody knows".
   */
  run(statement: SqlStatement, options?: RunOptions): Promise<readonly SqlRow[]>
  /** Whether a TRY_TO_CONNECT/BEGIN style probe has succeeded. Never assumed true. */
  healthy?(): Promise<boolean>
}

/** Why a statement was run, for the recording fake's assertions. */
export interface RecordedRun {
  readonly sql: string
  readonly params: readonly SqlParameter[]
  readonly transaction: boolean
}
