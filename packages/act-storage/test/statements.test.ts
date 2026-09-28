/**
 * The statements, as statements.
 *
 * These tests do not touch the fake client and do not claim a database agreed.
 * They assert the two things a reviewer can check by reading and a PostgreSQL
 * server cannot help with:
 *
 *   1. the claim is *one* statement, so nothing can interleave between a check
 *      and a write;
 *   2. every identity value reaches the server as a bound parameter, which is
 *      what makes a tenant id unable to become SQL text.
 *
 * The claim that PostgreSQL treats these the way this package assumes — zero
 * rows from a lost `ON CONFLICT DO NOTHING`, zero rows from a `WHERE` that
 * matches nothing — is stated in the headers and left to the "remaining
 * database verification" section of the Result. No test here can make it.
 */

import { describe, expect, test } from 'vitest'

import {
  ATTEMPT_COLUMNS,
  claimStatement,
  lookupStatement,
  settleStatement,
  type SettlementStatementParams,
} from '../src/statements.js'

/** Collapse the statements' formatting so a test can assert on one string. */
function squeeze(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

const IDENTITY = {
  tenantId: 'tenant-1',
  actionKind: 'booking',
  idempotencyKey: 'key-1',
} as const

/** Six columns, no more: what the ports need and nothing else. */
const EXPECTED_COLUMNS = 'tenant_id, action_kind, idempotency_key, fingerprint, state, provider_id'

describe('claimStatement', () => {
  const statement = claimStatement({
    tenantId: 'tenant-42',
    actionKind: 'booking',
    idempotencyKey: 'key-42',
    fingerprint: 'fp-42',
    openingState: 'in_flight',
  })

  test('is a single insert-or-nothing, so no read can race it', () => {
    expect(squeeze(statement.sql)).toBe(
      'INSERT INTO act_attempts ' +
        '(tenant_id, action_kind, idempotency_key, fingerprint, state) ' +
        'VALUES ($1, $2, $3, $4, $5) ' +
        'ON CONFLICT DO NOTHING ' +
        `RETURNING ${EXPECTED_COLUMNS}`,
    )
  })

  test('names no SELECT, because the insert itself is the test of ownership', () => {
    expect(statement.sql).not.toContain('SELECT')
  })

  test('binds the identity, the fingerprint and the opening state in order', () => {
    expect(statement.params).toEqual(['tenant-42', 'booking', 'key-42', 'fp-42', 'in_flight'])
  })

  test('puts no tenant id, key or fingerprint into the statement text', () => {
    for (const secret of ['tenant-42', 'key-42', 'fp-42']) {
      expect(statement.sql).not.toContain(secret)
    }
  })
})

describe('lookupStatement', () => {
  const statement = lookupStatement(IDENTITY)

  test('reads exactly the six columns and nothing else', () => {
    expect(squeeze(statement.sql)).toBe(
      `SELECT ${EXPECTED_COLUMNS} FROM act_attempts ` +
        'WHERE tenant_id = $1 AND action_kind = $2 AND idempotency_key = $3',
    )
  })

  test('scopes the read to the identity it was asked about', () => {
    expect(statement.params).toEqual(['tenant-1', 'booking', 'key-1'])
  })
})

describe('settleStatement', () => {
  const params: SettlementStatementParams = {
    tenantId: 'tenant-42',
    actionKind: 'email',
    idempotencyKey: 'key-42',
    fromState: 'prepared',
    toState: 'accepted',
    providerId: 'msg-1',
  }
  const statement = settleStatement(params)

  test('compares and swaps in one statement, with the compare in the WHERE', () => {
    expect(squeeze(statement.sql)).toBe(
      'UPDATE act_attempts ' +
        'SET state = $5, provider_id = $6, settled_at = now() ' +
        'WHERE tenant_id = $1 AND action_kind = $2 AND idempotency_key = $3 ' +
        'AND state = $4 ' +
        `RETURNING ${EXPECTED_COLUMNS}`,
    )
  })

  test('binds the previous state as $4 and the next state as $5', () => {
    expect(statement.params).toEqual([
      'tenant-42',
      'email',
      'key-42',
      'prepared',
      'accepted',
      'msg-1',
    ])
  })

  test('writes null rather than the string "null" for a settlement with no id', () => {
    expect(settleStatement({ ...params, providerId: null }).params[5]).toBeNull()
  })

  test('uses a contiguous run of placeholders, with no gap a value could fill', () => {
    const placeholders = statement.sql.match(/\$\d+/g) ?? []
    // The SET clause comes before the WHERE clause in the text, so this is not
    // the binding order — that is what the params assertion above pins. This is
    // the gap-and-duplicate check: six distinct numbers, $1 through $6, each
    // exactly once. A $3 used twice would bind one value to two meanings.
    expect(placeholders).toHaveLength(6)
    expect(new Set(placeholders)).toEqual(new Set(['$1', '$2', '$3', '$4', '$5', '$6']))
  })
})

describe('ATTEMPT_COLUMNS', () => {
  test('is the projection both statements return, and no timestamp', () => {
    expect([...ATTEMPT_COLUMNS]).toEqual([
      'tenant_id',
      'action_kind',
      'idempotency_key',
      'fingerprint',
      'state',
      'provider_id',
    ])
  })
})
