/**
 * The statements, as statements.
 *
 * These tests do not touch the fake client and do not claim a database agreed.
 * They assert the three things a reviewer can check by reading and a PostgreSQL
 * server cannot help with:
 *
 *   1. `consume` is *one* conditional statement, so nothing can interleave
 *      between reading the row and spending it;
 *   2. every value the store holds — tenant, session, action, both digests, the
 *      supplied time — reaches the server as a bound parameter, which is what
 *      makes a tenant id unable to become SQL text;
 *   3. each placeholder is bound exactly once, so no value carries two meanings.
 *
 * The claim that PostgreSQL treats these the way this package assumes — zero
 * rows from a lost `ON CONFLICT (id) DO NOTHING`, zero rows from a `WHERE` that
 * matches nothing, one row from a `RETURNING` that transitioned one row — is
 * stated in the headers and left to `scripts/verify-against-postgres.ts` and the
 * "remaining database verification" section of the Result. No test here can make
 * it.
 */

import { describe, expect, test } from 'vitest'

import type {
  ConfirmationChallengeConsumption,
  ConfirmationChallengeInsert,
} from '@archava/act-confirmation'
import {
  CHALLENGE_COLUMNS,
  consumeChallengeStatement,
  issueChallengeStatement,
  lookupChallengeStatement,
} from '../src/statements.js'

/** Collapse the statements' formatting so a test can assert on one string. */
function squeeze(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** Every placeholder in a statement, in order of first appearance. */
function placeholders(sql: string): string[] {
  return [...sql.matchAll(/\$\d+/g)].map((match) => match[0])
}

const INSERT: ConfirmationChallengeInsert = {
  id: 'challenge-42',
  tenantId: 'tenant-42',
  sessionId: 'session-42',
  actionId: 'action-42',
  tokenDigest: 'a'.repeat(64),
  bindingDigest: 'b'.repeat(64),
  issuedAt: 1770000000000,
  expiresAt: 1770000300000,
}

/** Ten columns: the identifiers, the two digests, the state, the instants. */
const EXPECTED_COLUMNS =
  'id, tenant_id, session_id, action_id, token_digest, binding_digest, ' +
  'state, issued_at, expires_at, consumed_at'

describe('CHALLENGE_COLUMNS', () => {
  test('names the columns the port reads, and no others', () => {
    expect(CHALLENGE_COLUMNS.join(', ')).toBe(EXPECTED_COLUMNS)
  })
})

describe('issueChallengeStatement', () => {
  const statement = issueChallengeStatement(INSERT)

  test('is a single insert-or-nothing, so two issuers cannot both win', () => {
    expect(squeeze(statement.sql)).toBe(
      'INSERT INTO confirmation_challenges ' +
        '(id, tenant_id, session_id, action_id, token_digest, binding_digest, state, ' +
        "issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) " +
        'ON CONFLICT (id) DO NOTHING RETURNING id',
    )
  })

  test('binds every caller value in order', () => {
    expect(statement.params).toEqual([
      INSERT.id,
      INSERT.tenantId,
      INSERT.sessionId,
      INSERT.actionId,
      INSERT.tokenDigest,
      INSERT.bindingDigest,
      INSERT.issuedAt,
      INSERT.expiresAt,
    ])
  })

  test('writes the opening state as a literal, not as caller data', () => {
    // Nothing a caller supplies can reach the state column: it is not a
    // parameter. A challenge is pending until it is spent, by construction.
    expect(squeeze(statement.sql)).toContain("'pending'")
    expect(placeholders(statement.sql)).toEqual(['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8'])
  })

  test('binds each placeholder exactly once', () => {
    const seen = placeholders(statement.sql)
    expect([...new Set(seen)]).toEqual(seen)
  })
})

describe('consumeChallengeStatement', () => {
  const PRESENTATION: ConfirmationChallengeConsumption = {
    id: 'challenge-42',
    tenantId: 'tenant-42',
    sessionId: 'session-42',
    actionId: 'action-42',
    tokenDigest: 'c'.repeat(64),
    bindingDigest: 'd'.repeat(64),
    now: 1770000123000,
  }
  const statement = consumeChallengeStatement(PRESENTATION)

  test('is one conditional update, so no read can race the write', () => {
    expect(squeeze(statement.sql)).toBe(
      "UPDATE confirmation_challenges SET state = 'consumed', consumed_at = $2 " +
        'WHERE id = $1 AND tenant_id = $3 AND session_id = $4 AND action_id = $5 ' +
        "AND token_digest = $6 AND binding_digest = $7 AND state = 'pending' " +
        'AND $8 >= issued_at AND $9 < expires_at RETURNING ' +
        EXPECTED_COLUMNS,
    )
  })

  test('binds every identity and digest as a parameter, in predicate order', () => {
    expect(statement.params).toEqual([
      PRESENTATION.id,
      PRESENTATION.now,
      PRESENTATION.tenantId,
      PRESENTATION.sessionId,
      PRESENTATION.actionId,
      PRESENTATION.tokenDigest,
      PRESENTATION.bindingDigest,
      PRESENTATION.now,
      PRESENTATION.now,
    ])
  })

  test('compares the supplied time against the complete stored window, not the clock', () => {
    // now() would make the statement's answer depend on the database's clock,
    // which the service neither controls nor can observe. The caller supplied
    // the instant; the caller's instant is what is compared.
    expect(statement.sql).not.toContain('now()')
    expect(squeeze(statement.sql)).toContain('AND $8 >= issued_at AND $9 < expires_at')
  })

  test('binds each placeholder exactly once', () => {
    const seen = placeholders(statement.sql)
    expect([...new Set(seen)]).toEqual(seen)
  })

  test('keeps the transition state and the stamp in the same statement', () => {
    // A row that is marked consumed without its instant, or stamped without
    // being marked, is a row the service cannot reconcile. Both move together.
    expect(squeeze(statement.sql)).toContain("SET state = 'consumed', consumed_at = $2")
  })
})

describe('lookupChallengeStatement', () => {
  const statement = lookupChallengeStatement('challenge-42')

  test('is a single read scoped to the challenge id', () => {
    expect(squeeze(statement.sql)).toBe(
      `SELECT ${EXPECTED_COLUMNS} FROM confirmation_challenges WHERE id = $1`,
    )
    expect(statement.params).toEqual(['challenge-42'])
  })

  test('scopes to the id alone, so classification never invents a scope', () => {
    // The comparison against the presented tenant, session, action and digests
    // happens in the store, over the row this returns. Scoping the SELECT by
    // them too would turn "wrong tenant" into "no such challenge", and the store
    // would lose the ability to tell a caller it matched nothing.
    expect(statement.sql).not.toContain('tenant_id =')
    expect(statement.sql).not.toContain('session_id =')
  })
})
