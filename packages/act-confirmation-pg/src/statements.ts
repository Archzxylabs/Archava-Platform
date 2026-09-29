/**
 * The statements, as statements.
 *
 * This file exists so that the SQL is somewhere a reviewer can read it in one
 * sitting, and so that it is the *only* place in this package where a statement is
 * built. Nothing here interpolates a caller value: every identity, digest and
 * instant the service hands over becomes a bound `$n` parameter, which is why a
 * tenant id cannot become SQL text — the only thing this package could produce
 * with one is a placeholder.
 *
 * Three statements, and each is one statement for a reason.
 *
 *   1. `issue` is a single `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING`.
 *      The conflict target is named, so a uniqueness violation that is not the
 *      primary key raises rather than being swallowed. Two issuers of one id
 *      produce one row, and the loser gets zero rows back rather than an error.
 *   2. `consume` is a single conditional `UPDATE ... RETURNING`. The predicate
 *      carries the challenge id, the tenant, the session, the action, both
 *      digests, the current state and both bounds of the time window, so the
 *      decision is made by the database in the same step that spends the row. There is no
 *      read followed by a write, and therefore nothing two concurrent
 *      presentations can both complete.
 *   3. `lookup` is a read, and reads nothing but the id. It exists to classify
 *      a zero-row transition *after* the fact: whether the challenge exists,
 *      and in what state. Scoping it by tenant, session or digests would turn
 *      "wrong tenant" into "no such challenge", which is the one distinction
 *      this package is required to be able to make.
 *
 * The state literals — `'pending'` and `'consumed'` — appear in the statement
 * text rather than in `params`. A caller does not supply them and cannot reach
 * them, which is the point: a challenge is pending until PostgreSQL says
 * otherwise, and the only writer of `'consumed'` is this predicate.
 */

import type {
  ConfirmationChallengeConsumption,
  ConfirmationChallengeInsert,
} from '@archava/act-confirmation'
import type { SqlStatement } from '@archava/act-storage'

/** The columns `confirmation_challenges` has, in the order the port reads them. */
export const CHALLENGE_COLUMNS = [
  'id',
  'tenant_id',
  'session_id',
  'action_id',
  'token_digest',
  'binding_digest',
  'state',
  'issued_at',
  'expires_at',
  'consumed_at',
] as const

/**
 * Write a pending challenge, or nothing.
 *
 * `ON CONFLICT (id)` names the primary key as the arbiter. A deferrable unique
 * constraint "cannot be used as a conflict arbiter", so this statement would
 * raise on a second issuer if the key were deferrable — and a targetless
 * `DO NOTHING` would swallow a violation from *any* unique constraint, turning a
 * misconfiguration into a silent "inserted". Only rows that were actually
 * inserted are returned, so zero rows is an unambiguous answer: the id is taken.
 */
export function issueChallengeStatement(insert: ConfirmationChallengeInsert): SqlStatement {
  return {
    sql: [
      'INSERT INTO confirmation_challenges',
      '  (id, tenant_id, session_id, action_id, token_digest, binding_digest,',
      "   state, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)",
      'ON CONFLICT (id) DO NOTHING',
      'RETURNING id',
    ].join('\n'),
    params: [
      insert.id,
      insert.tenantId,
      insert.sessionId,
      insert.actionId,
      insert.tokenDigest,
      insert.bindingDigest,
      insert.issuedAt,
      insert.expiresAt,
    ],
  }
}

/**
 * Spend a pending, in-window, matching challenge — or spend nothing.
 *
 * The parameter order is deliberate and load-bearing. `$2` (the stamp), `$8`
 * (the opening bound), and `$9` (the expiry bound) carry the same caller-supplied
 * instant. Binding them in this order keeps the transition and checks on one timeline:
 * the row is stamped consumed at the moment the predicate tested, never at a
 * moment it did not.
 *
 * `$8 >= issued_at AND $9 < expires_at` compares the caller's instant against
 * the complete stored window. The three time parameters carry the same value. The
 * database's own `now()` is never used: the service neither controls it nor can
 * observe it, and a clock disagreement between them would make the same
 * presentation spendable or not depending on where it landed.
 */
export function consumeChallengeStatement(
  presentation: ConfirmationChallengeConsumption,
): SqlStatement {
  return {
    sql: [
      'UPDATE confirmation_challenges SET',
      "  state = 'consumed',",
      '  consumed_at = $2',
      'WHERE id = $1',
      '  AND tenant_id = $3',
      '  AND session_id = $4',
      '  AND action_id = $5',
      '  AND token_digest = $6',
      '  AND binding_digest = $7',
      "  AND state = 'pending'",
      '  AND $8 >= issued_at',
      '  AND $9 < expires_at',
      `RETURNING ${CHALLENGE_COLUMNS.join(', ')}`,
    ].join('\n'),
    params: [
      presentation.id,
      presentation.now,
      presentation.tenantId,
      presentation.sessionId,
      presentation.actionId,
      presentation.tokenDigest,
      presentation.bindingDigest,
      presentation.now,
      presentation.now,
    ],
  }
}

/**
 * Read one challenge by id, and nothing else.
 *
 * No tenant, session, action, digest or state predicate. The comparison against
 * what was presented happens in this package, over the row this returns, so that
 * a row belonging to somebody else can be *recognised* rather than merely missed.
 */
export function lookupChallengeStatement(id: string): SqlStatement {
  return {
    sql: [
      `SELECT ${CHALLENGE_COLUMNS.join(', ')}`,
      'FROM confirmation_challenges',
      'WHERE id = $1',
    ].join('\n'),
    params: [id],
  }
}
