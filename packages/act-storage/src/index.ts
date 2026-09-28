/**
 * @archava/act-storage — the durable attempt stores for the Act boundaries.
 *
 * One narrow thing: hold the record of an attempt to perform a side effect, so
 * that "at most once" is decided by a unique index in a database rather than by
 * a read that could race. Nothing here decides whether an action is allowed,
 * whether it succeeded, or what to do next — those decisions live in the
 * boundaries in `packages/act-booking` and `packages/act-email`, and this
 * package is only the durable half of them. The public store ports continue to
 * use the pipeline's raw idempotency key, but the SQL identity is its HMAC.
 *
 * There is no driver here. Every statement goes through an injected `SqlClient`
 * that the deployment supplies, which is what lets these stores be tested
 * against a recording fake with no database in CI.
 *
 * The SQL is in `migrations/001_act_attempts.sql`. Read its header before
 * changing the schema: the unique constraint on
 * `(tenant_id, action_kind, idempotency_key)` is the whole atomic claim, and
 * making it DEFERRABLE would silently cost this package its guarantee. The
 * storage HMAC secret must be stable for every process and every replay of a
 * row. Rotate it only with a migration of existing attempt identities.
 */

export {
  BOOKING_ACTION_KIND,
  PostgresBookingAttemptStore,
  type PostgresBookingAttemptStoreOptions,
} from './booking-store.js'

export {
  EMAIL_ACTION_KIND,
  PostgresEmailAttemptStore,
  type PostgresEmailAttemptStoreOptions,
} from './email-store.js'

export {
  BOOKING_STATES,
  EMAIL_STATES,
  ATTEMPT_STATES,
  readAttemptRow,
  readAttemptRows,
  type RowReading,
} from './row.js'

export {
  ATTEMPT_COLUMNS,
  claimStatement,
  lookupStatement,
  settleStatement,
  type SettlementStatementParams,
} from './statements.js'

export {
  claimAttempt,
  lookupAttempt,
  settleAttempt,
  type AttemptIdentity,
  type AttemptReading,
  type AttemptRow,
  type ClaimAttempt,
  type SettleAttempt,
} from './core.js'

export type {
  RecordedRun,
  RunOptions,
  SqlClient,
  SqlClientCapabilities,
  SqlParameter,
  SqlRow,
  SqlStatement,
} from './sql.js'

/**
 * The migrations, in the order they must be applied.
 *
 * A list of filenames rather than of SQL text, so that whoever applies them is
 * the one who reads them, and so a bundler cannot inline a schema this package
 * has not verified against a real database.
 */
export const MIGRATIONS = ['001_act_attempts.sql'] as const
