/**
 * Reading a row back without believing it.
 *
 * A row that comes out of a database has been through a driver and a codec and
 * is not, merely by arriving, a record this package may report. These tests pin
 * the two refusals that keep a broken row from becoming a double booking:
 *
 *   * a row answering a different identity is refused *by name*, so a
 *     cross-tenant answer is a finding and not a miss;
 *   * a row that does not check out is `malformed` and never `absent`, because
 *     `absent` lets a caller conclude the key is free.
 *
 * What these tests do not prove: that PostgreSQL can produce such a row. The
 * database is constrained to what this reader expects, and the constraints
 * themselves are only verified by applying the migration to a real server. This
 * file is about what happens when the constraint, the schema or the driver is
 * wrong anyway.
 */

import { describe, expect, test } from 'vitest'

import type { SqlRow } from '../src/sql.js'
import { ATTEMPT_STATES, readAttemptRow, readAttemptRows } from '../src/row.js'

const EXPECTED = {
  tenantId: 'tenant-1',
  actionKind: 'booking',
  idempotencyKey: 'key-1',
} as const

/** The row this package is willing to report, unless a test breaks it. */
function row(overrides: Readonly<Record<string, unknown>> = {}): SqlRow {
  return {
    tenant_id: 'tenant-1',
    action_kind: 'booking',
    idempotency_key: 'key-1',
    fingerprint: 'fp-1',
    state: 'in_flight',
    provider_id: null,
    ...overrides,
  }
}

describe('readAttemptRows', () => {
  test('zero rows is absent, which is an answer and not an error', () => {
    expect(readAttemptRows([], EXPECTED)).toEqual({ status: 'absent' })
  })

  test('more than one row for one identity is a refusal, not a silent first', () => {
    const reading = readAttemptRows([row(), row()], EXPECTED)
    expect(reading).toEqual({ status: 'malformed', reason: 'multiple_rows_for_one_identity' })
  })
})

describe('readAttemptRow identity', () => {
  test('the row it asked for, with the values it carries', () => {
    expect(readAttemptRow(row(), EXPECTED)).toEqual({
      status: 'record',
      tenantId: 'tenant-1',
      actionKind: 'booking',
      idempotencyKey: 'key-1',
      fingerprint: 'fp-1',
      state: 'in_flight',
      providerId: null,
    })
  })

  test('a row naming another tenant is refused as a cross-tenant answer', () => {
    expect(readAttemptRow(row({ tenant_id: 'tenant-2' }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'tenant_mismatch',
    })
  })

  test('a row naming another action is refused, not translated', () => {
    expect(readAttemptRow(row({ action_kind: 'email' }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'action_kind_mismatch',
    })
  })

  test('a row naming another key is refused', () => {
    expect(readAttemptRow(row({ idempotency_key: 'key-2' }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'idempotency_key_mismatch',
    })
  })
})

describe('readAttemptRow values', () => {
  /**
   * The identity check runs first and compares strictly, so an empty tenant id
   * only reaches the "unusable" refusal when the caller supplied the empty one
   * — which is the case worth pinning: a key scoped to nothing is not a key.
   */
  test('a blank tenant id is not a tenant', () => {
    expect(readAttemptRow(row({ tenant_id: '' }), { ...EXPECTED, tenantId: '' })).toEqual({
      status: 'malformed',
      reason: 'tenant_id_unusable',
    })
  })

  test.each(['fingerprint', 'state'])('an empty %s is unusable', (column) => {
    const reading = readAttemptRow(row({ [column]: '' }), EXPECTED)
    expect(reading.status).toBe('malformed')
  })

  test('a state outside the known sets is refused, not coerced to unknown', () => {
    expect(readAttemptRow(row({ state: 'maybe' }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'state_unknown',
    })
  })

  test('a driver that hands back a number for a string column is refused', () => {
    expect(readAttemptRow(row({ idempotency_key: 17 }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'idempotency_key_mismatch',
    })
  })

  test('every state either boundary can write is known', () => {
    for (const state of ['in_flight', 'prepared', 'confirmed', 'accepted', 'rejected', 'unknown']) {
      expect(ATTEMPT_STATES.has(state)).toBe(true)
    }
  })
})

describe('readAttemptRow provider id', () => {
  test('a confirmed row carries its reference', () => {
    const reading = readAttemptRow(row({ state: 'confirmed', provider_id: 'bkf-1' }), EXPECTED)
    expect(reading.status).toBe('record')
    if (reading.status === 'record') expect(reading.providerId).toBe('bkf-1')
  })

  test('a confirmed row without a reference is not a confirmation', () => {
    expect(readAttemptRow(row({ state: 'confirmed', provider_id: null }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'confirmed_state_without_provider_id',
    })
  })

  test('a reference in a state that may not carry one is refused', () => {
    expect(readAttemptRow(row({ state: 'in_flight', provider_id: 'bkf-1' }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'provider_id_in_wrong_state',
    })
  })

  test('an empty reference is not a reference', () => {
    expect(readAttemptRow(row({ state: 'accepted', provider_id: '' }), EXPECTED)).toEqual({
      status: 'malformed',
      reason: 'provider_id_unusable',
    })
  })

  test('a missing provider_id column is indistinguishable from null', () => {
    const reading = readAttemptRow(row({ provider_id: undefined }), EXPECTED)
    expect(reading.status).toBe('record')
    if (reading.status === 'record') expect(reading.providerId).toBeNull()
  })
})
