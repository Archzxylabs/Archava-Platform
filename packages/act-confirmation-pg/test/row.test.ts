/**
 * The row reader, as a boundary.
 *
 * A row that came back from PostgreSQL has been through a database, a driver and
 * a codec, and none of them can vouch for what it means. These tests assert the
 * reader refuses rather than repairs — a fractional instant, a state outside the
 * port's four, a `consumed_at` that disagrees with its state, a row that answers
 * a different challenge than the one asked for. Each refusal is a separate test
 * because each is a separate way a caller could end up believing something.
 *
 * The distinction under test throughout is between *absent* (a normal answer:
 * nothing there) and *malformed* (something was there and it does not check out).
 * Collapsing the second into the first would let a store answer "no such
 * challenge" about a row it simply could not read, which for a confirmation is
 * consent spent without a record.
 */

import { describe, expect, test } from 'vitest'

import type { SqlRow } from '@archava/act-storage'
import { readMilliseconds, readChallengeRow, readChallengeRows } from '../src/row.js'

/** A pending row, as the migration writes one. Overridden per test. */
function pending(overrides: Readonly<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'challenge-1',
    tenant_id: 'tenant-1',
    session_id: 'session-1',
    action_id: 'action-1',
    token_digest: 'a'.repeat(64),
    binding_digest: 'b'.repeat(64),
    state: 'pending',
    issued_at: 1770000000000,
    expires_at: 1770000300000,
    consumed_at: null,
    ...overrides,
  }
}

describe('readChallengeRows', () => {
  test('reports zero rows as absent, because none is an answer', () => {
    expect(readChallengeRows([], 'challenge-1')).toEqual({ status: 'absent' })
  })

  test('refuses two rows for one id rather than picking a winner', () => {
    const reading = readChallengeRows([pending(), pending({ id: 'challenge-1' })], 'challenge-1')
    expect(reading).toEqual({
      status: 'malformed',
      reason: 'multiple_rows_for_one_challenge',
    })
  })
})

describe('readMilliseconds', () => {
  // The store uses this on the *caller's* side too, not only on a row's, because
  // an instant it cannot read is one it must refuse before it spends anything.
  test('reads the two shapes a bigint column can arrive as', () => {
    expect(readMilliseconds(1770000000000)).toBe(1770000000000)
    expect(readMilliseconds('1770000000000')).toBe(1770000000000)
    expect(readMilliseconds(0)).toBe(0)
  })

  test('refuses an instant it cannot read', () => {
    for (const value of [
      1.5,
      1770000000000.5,
      -1,
      '1770000000000.5',
      '0x10',
      ' 12',
      '',
      'soon',
      null,
      undefined,
      true,
      {},
    ]) {
      expect(readMilliseconds(value)).toBeNull()
    }
  })
})

describe('readChallengeRow', () => {
  test('returns the record a pending row describes', () => {
    const reading = readChallengeRow(pending(), 'challenge-1')
    expect(reading).toEqual({
      status: 'record',
      challenge: {
        id: 'challenge-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        actionId: 'action-1',
        tokenDigest: 'a'.repeat(64),
        bindingDigest: 'b'.repeat(64),
        state: 'pending',
        issuedAt: 1770000000000,
        expiresAt: 1770000300000,
      },
    })
  })

  test('omits consumedAt entirely while the challenge is pending', () => {
    const reading = readChallengeRow(pending(), 'challenge-1')
    expect(reading.status).toBe('record')
    if (reading.status !== 'record') return
    // Absent from the object, not present-and-undefined: a record that carries
    // the key with no value is one a caller can misread as "unknown whether spent".
    expect('consumedAt' in reading.challenge).toBe(false)
  })

  test('carries the consumption instant once the row claims one', () => {
    const reading = readChallengeRow(
      pending({ state: 'consumed', consumed_at: 1770000123000 }),
      'challenge-1',
    )
    expect(reading.status).toBe('record')
    if (reading.status !== 'record') return
    expect(reading.challenge.state).toBe('consumed')
    expect(reading.challenge.issuedAt).toBe(1770000000000)
    expect(reading.challenge.expiresAt).toBe(1770000300000)
    expect(reading.challenge.consumedAt).toBe(1770000123000)
  })

  test('accepts bigint instants as decimal strings, which is what pg returns', () => {
    const reading = readChallengeRow(
      pending({ issued_at: '1770000000000', expires_at: '1770000300000' }),
      'challenge-1',
    )
    expect(reading.status).toBe('record')
    if (reading.status !== 'record') return
    expect(reading.challenge.issuedAt).toBe(1770000000000)
    expect(reading.challenge.expiresAt).toBe(1770000300000)
  })

  test.each(['id', 'tenant_id', 'session_id', 'action_id', 'token_digest', 'binding_digest'])(
    'refuses a row whose %s is missing or empty',
    (column) => {
      expect(readChallengeRow(pending({ [column]: null }), 'challenge-1')).toEqual({
        status: 'malformed',
        reason: `${column}_missing`,
      })
      expect(readChallengeRow(pending({ [column]: '' }), 'challenge-1')).toEqual({
        status: 'malformed',
        reason: `${column}_missing`,
      })
    },
  )

  test('refuses a row that answers a different challenge', () => {
    const reading = readChallengeRow(pending({ id: 'challenge-2' }), 'challenge-1')
    expect(reading).toEqual({ status: 'malformed', reason: 'challenge_id_mismatch' })
  })

  test('refuses a state outside the four the port defines', () => {
    expect(readChallengeRow(pending({ state: 'spent' }), 'challenge-1')).toEqual({
      status: 'malformed',
      reason: 'state_unknown',
    })
    expect(readChallengeRow(pending({ state: null }), 'challenge-1')).toEqual({
      status: 'malformed',
      reason: 'state_unknown',
    })
  })

  test('refuses an instant the service could not have computed', () => {
    for (const issued of [1.5, -1, '1770000000000.5', '0x10', ' 12', '']) {
      expect(readChallengeRow(pending({ issued_at: issued }), 'challenge-1')).toEqual({
        status: 'malformed',
        reason: 'issued_at_unreadable',
      })
    }
    for (const expires of [1.5, -1, 'soon']) {
      expect(readChallengeRow(pending({ expires_at: expires }), 'challenge-1')).toEqual({
        status: 'malformed',
        reason: 'expires_at_unreadable',
      })
    }
  })

  test('refuses a window that is not positive, so a challenge is never born expired', () => {
    expect(readChallengeRow(pending({ expires_at: 1770000000000 }), 'challenge-1')).toEqual({
      status: 'malformed',
      reason: 'window_not_positive',
    })
    expect(readChallengeRow(pending({ expires_at: 1769999999999 }), 'challenge-1')).toEqual({
      status: 'malformed',
      reason: 'window_not_positive',
    })
  })

  test('refuses a consumed row that claims no instant it was spent at', () => {
    expect(readChallengeRow(pending({ state: 'consumed' }), 'challenge-1')).toEqual({
      status: 'malformed',
      reason: 'consumed_without_an_instant',
    })
  })

  test('refuses an unconsumed row that carries a consumption instant', () => {
    expect(readChallengeRow(pending({ consumed_at: 1770000123000 }), 'challenge-1')).toEqual({
      status: 'malformed',
      reason: 'unstamped_state_carrying_an_instant',
    })
  })

  test('refuses a consumption instant that cannot be read', () => {
    expect(
      readChallengeRow(pending({ state: 'consumed', consumed_at: 'when' }), 'challenge-1'),
    ).toEqual({ status: 'malformed', reason: 'consumed_at_unreadable' })
  })

  test('refuses a consumption that predates the issue', () => {
    expect(
      readChallengeRow(pending({ state: 'consumed', consumed_at: 1769999999999 }), 'challenge-1'),
    ).toEqual({ status: 'malformed', reason: 'consumed_before_issued' })
  })
})
