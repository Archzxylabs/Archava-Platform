/**
 * @archava/act-confirmation-pg — the PostgreSQL confirmation challenge store.
 *
 * The durable half of the Act confirmation boundary. A confirmation is consent,
 * and this package holds it so that "a consent is spent at most once" is decided
 * by a primary key and a conditional update in a database rather than by a read
 * that could race one.
 *
 * The port lives in `@archava/act-confirmation`; this is the adapter. It owns
 * the three places the atomicity actually comes from:
 *
 *   * the migration, `migrations/001_confirmation_challenges.sql`, whose primary
 *     key and CHECK constraints the statements below rely on;
 *   * the statements, `statements.ts`, every one of which is a single statement
 *     for the reason its header gives;
 *   * the row reader, `row.ts`, which refuses a row it cannot vouch for rather
 *     than repairing it — the difference between a store answering and a store
 *     guessing.
 *
 * There is no driver here. Every statement goes through an injected `SqlClient`
 * the deployment supplies, which is what lets the whole package be tested
 * against a recording fake with no database in CI.
 *
 * What this package never holds: the confirmation token or any prefix of it, the
 * HMAC key or anything derivable from it, raw action input, entity resolution
 * output, provider payloads, browser identifiers, IP addresses, user agents, or
 * tenant PII of any kind. The two digests are stored because they are one-way;
 * nothing else about a presentation is durable here.
 */

export {
  CHALLENGE_COLUMNS,
  consumeChallengeStatement,
  issueChallengeStatement,
  lookupChallengeStatement,
} from './statements.js'

export {
  readMilliseconds,
  readChallengeRow,
  readChallengeRows,
  type ChallengeRowReading,
} from './row.js'

export { PostgresChallengeStore } from './postgres-challenge-store.js'
