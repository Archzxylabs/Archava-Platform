/**
 * The booking attempt store, against the recording fake.
 *
 * What these tests prove:
 *
 *   * the claim reaches the adapter as ONE `INSERT ... ON CONFLICT DO NOTHING`,
 *     and a key that is taken produces a read of the owner's record — never a
 *     second insert, never a blind `accepted`;
 *   * the settlement's compare-and-swap is honoured: a record that is no longer
 *     `in_flight` is not overwritten, and the caller is handed the durable
 *     record instead of being told "done";
 *   * an error is never an answer. Every thrown case below is a case where the
 *     alternative would be to report a reservation that was not, or was, made.
 *
 * What these tests DO NOT prove:
 *
 *   * that PostgreSQL would have made the claim atomic. The fake imitates
 *     `ON CONFLICT DO NOTHING` with a single-process `Map`; the real guarantee
 *     is the NOT DEFERRABLE primary key in `migrations/001_act_attempts.sql`,
 *     verified by applying that migration to a real server (see the Result).
 *   * that two real processes racing would produce one winner. The
 *     `Promise.all` test below interleaves two callers in one process against
 *     that `Map`; it proves neither adapter invents a second insert, not that
 *     a real database serializes them. The fake is not concurrency.
 *   * durability across a restart, or that the database accepted the SQL.
 */

import { describe, expect, test } from 'vitest'

import type { BookingAttemptRecord, BookingAttemptSettlement } from '@archava/act-booking'
import { BOOKING_ACTION_KIND, PostgresBookingAttemptStore } from '../src/booking-store.js'
import { attemptStorageKey } from '../src/storage-key.js'
import { RecordingSqlClient, type StoredAttempt } from './recording-sql-client.js'

const STORAGE_SECRET = new Uint8Array(32).fill(7)
const storedKey = (tenantId = 'tenant-1', actionKind = BOOKING_ACTION_KIND, rawKey = 'key-1') =>
  attemptStorageKey(STORAGE_SECRET, tenantId, actionKind, rawKey)
const STORED_KEY = storedKey()

function makeStore(client: RecordingSqlClient): PostgresBookingAttemptStore {
  return new PostgresBookingAttemptStore({ client, idempotencyKeyHmacKey: STORAGE_SECRET })
}

const IN_FLIGHT: StoredAttempt = {
  tenantId: 'tenant-1',
  actionKind: BOOKING_ACTION_KIND,
  idempotencyKey: STORED_KEY,
  fingerprint: 'fp-1',
  state: 'in_flight',
  providerId: null,
}

function claimOf(overrides: Partial<BookingAttemptRecord> = {}): BookingAttemptRecord {
  return {
    tenantId: 'tenant-1',
    idempotencyKey: 'key-1',
    fingerprint: 'fp-1',
    state: 'in_flight',
    ...overrides,
  }
}

function settleOf(overrides: Partial<BookingAttemptSettlement> = {}): BookingAttemptSettlement {
  return {
    tenantId: 'tenant-1',
    idempotencyKey: 'key-1',
    from: 'in_flight',
    state: 'confirmed',
    bookingReference: 'BK-1',
    ...overrides,
  }
}

describe('claim', () => {
  test('a fresh key is claimed with one insert-or-nothing', async () => {
    const client = new RecordingSqlClient()
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({ status: 'accepted' })

    const statement = client.only
    expect(statement.sql).toContain('INSERT INTO act_attempts')
    expect(statement.sql).toContain('ON CONFLICT DO NOTHING')
    expect(statement.sql).not.toContain('SELECT')
    expect(statement.params).toEqual(['tenant-1', 'booking', STORED_KEY, 'fp-1', 'in_flight'])
    expect(client.inspect('tenant-1', 'booking', STORED_KEY)).toEqual(IN_FLIGHT)
  })

  test('a taken key is replayed from the durable record, not re-inserted', async () => {
    const client = new RecordingSqlClient({
      seed: [{ ...IN_FLIGHT, state: 'confirmed', providerId: 'BK-9' }],
    })
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({
      status: 'replayed',
      attempt: {
        tenantId: 'tenant-1',
        idempotencyKey: 'key-1',
        fingerprint: 'fp-1',
        state: 'confirmed',
        bookingReference: 'BK-9',
      },
    })

    expect(client.sql).toEqual([
      expect.stringContaining('INSERT'),
      expect.stringContaining('SELECT'),
    ])
    expect(client.runCount).toBe(2)
  })

  test('a lost claim leaves the owner’s record exactly where it was', async () => {
    const client = new RecordingSqlClient({ seed: [IN_FLIGHT] })
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({
      status: 'replayed',
      attempt: {
        tenantId: 'tenant-1',
        idempotencyKey: 'key-1',
        fingerprint: 'fp-1',
        state: 'in_flight',
      },
    })
    expect(client.inspect('tenant-1', 'booking', STORED_KEY)).toEqual(IN_FLIGHT)
  })

  test('two callers at once produce one owner and one replayer', async () => {
    const client = new RecordingSqlClient()
    const store = makeStore(client)

    const [first, second] = await Promise.all([store.claim(claimOf()), store.claim(claimOf())])

    expect(first).toEqual({ status: 'accepted' })
    expect(second.status).toBe('replayed')
    expect(client.sql.filter((sql) => sql.includes('INSERT'))).toHaveLength(2)
    expect(client.inspect('tenant-1', 'booking', STORED_KEY)).toEqual(IN_FLIGHT)
  })

  test('the same key under another tenant is a different attempt', async () => {
    const client = new RecordingSqlClient({ seed: [IN_FLIGHT] })
    const store = makeStore(client)

    expect(await store.claim(claimOf({ tenantId: 'tenant-2' }))).toEqual({ status: 'accepted' })
    expect(client.parameters[0]?.[0]).toBe('tenant-2')
    expect(client.inspect('tenant-1', 'booking', STORED_KEY)).toEqual(IN_FLIGHT)
    expect(client.inspect('tenant-2', 'booking', storedKey('tenant-2'))?.tenantId).toBe('tenant-2')
  })

  test('the same key under the email action kind is a different attempt', async () => {
    const client = new RecordingSqlClient({
      seed: [
        {
          ...IN_FLIGHT,
          actionKind: 'email',
          idempotencyKey: storedKey('tenant-1', 'email'),
          state: 'prepared',
        },
      ],
    })
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({ status: 'accepted' })
    expect(client.inspect('tenant-1', 'email', storedKey('tenant-1', 'email'))?.state).toBe(
      'prepared',
    )
  })

  test('a database that would not answer is a throw, not an accepted claim', async () => {
    const client = new RecordingSqlClient({ failFromCall: 0 })
    const store = makeStore(client)

    await expect(store.claim(claimOf())).rejects.toThrow(/booking_attempt_store_unavailable/)

    expect(client.runCount).toBe(1)
    expect(client.parameters[0]?.[4]).toBe('in_flight')
  })

  test('a lost insert whose read failed throws rather than inventing a replay', async () => {
    const client = new RecordingSqlClient({ seed: [IN_FLIGHT], failFromCall: 1 })
    const store = makeStore(client)

    await expect(store.claim(claimOf())).rejects.toThrow(/booking_attempt_store_unavailable/)
    expect(client.sql.filter((sql) => sql.includes('INSERT'))).toHaveLength(1)
  })

  test('a row that does not check out is refused, not reported as a record', async () => {
    const client = new RecordingSqlClient({ seed: [{ ...IN_FLIGHT, state: 'maybe' }] })
    const store = makeStore(client)

    await expect(store.claim(claimOf())).rejects.toThrow(/booking_attempt_row_state_unknown/)
  })
})

describe('settle', () => {
  test('the first confirmation is written and reported as settled', async () => {
    const client = new RecordingSqlClient({ seed: [IN_FLIGHT] })
    const store = makeStore(client)

    expect(await store.settle(settleOf())).toEqual({ status: 'settled' })

    expect(client.only.params).toEqual([
      'tenant-1',
      'booking',
      STORED_KEY,
      'in_flight',
      'confirmed',
      'BK-1',
    ])
    expect(client.inspect('tenant-1', 'booking', STORED_KEY)).toEqual({
      ...IN_FLIGHT,
      state: 'confirmed',
      providerId: 'BK-1',
    })
  })

  test('a refusal with no reference is settled on the same path', async () => {
    const client = new RecordingSqlClient({ seed: [IN_FLIGHT] })
    const store = makeStore(client)

    expect(
      await store.settle(settleOf({ state: 'rejected', bookingReference: undefined })),
    ).toEqual({ status: 'settled' })
    expect(client.only.params[5]).toBeNull()
  })

  test('a settlement that arrives late is stale and returns the durable record', async () => {
    const client = new RecordingSqlClient({
      seed: [{ ...IN_FLIGHT, state: 'confirmed', providerId: 'BK-9' }],
    })
    const store = makeStore(client)

    expect(await store.settle(settleOf({ state: 'unknown', bookingReference: undefined }))).toEqual(
      {
        status: 'stale',
        attempt: {
          tenantId: 'tenant-1',
          idempotencyKey: 'key-1',
          fingerprint: 'fp-1',
          state: 'confirmed',
          bookingReference: 'BK-9',
        },
      },
    )
    expect(client.inspect('tenant-1', 'booking', STORED_KEY)?.state).toBe('confirmed')
  })

  test('a confirmed record is never overwritten by a late reconciliation', async () => {
    const client = new RecordingSqlClient({
      seed: [{ ...IN_FLIGHT, state: 'confirmed', providerId: 'BK-9' }],
    })
    const store = makeStore(client)

    await store.settle(settleOf({ from: 'unknown', state: 'unknown' }))

    expect(client.inspect('tenant-1', 'booking', STORED_KEY)?.providerId).toBe('BK-9')
  })

  test('a stale settlement whose durable read fails is a throw', async () => {
    const client = new RecordingSqlClient({
      seed: [{ ...IN_FLIGHT, state: 'confirmed', providerId: 'BK-9' }],
      failFromCall: 1,
    })
    const store = makeStore(client)

    await expect(store.settle(settleOf())).rejects.toThrow(
      /booking_attempt_settlement_unresolvable/,
    )
  })

  test('a stale settlement with nothing durable is a throw', async () => {
    const store = new PostgresBookingAttemptStore({
      client: new RecordingSqlClient(),
      idempotencyKeyHmacKey: STORAGE_SECRET,
    })

    await expect(store.settle(settleOf())).rejects.toThrow(
      /booking_attempt_settlement_unresolvable/,
    )
  })

  test('a database that would not answer is a throw, not settled', async () => {
    const store = new PostgresBookingAttemptStore({
      client: new RecordingSqlClient({ seed: [IN_FLIGHT], failFromCall: 0 }),
      idempotencyKeyHmacKey: STORAGE_SECRET,
    })

    await expect(store.settle(settleOf())).rejects.toThrow(/booking_attempt_store_unavailable/)
  })
})

describe('what is never stored', () => {
  test('the raw input-bearing key stays out of SQL and the durable row', async () => {
    const rawKey = JSON.stringify({
      inputs: { customerRef: 'visitor-123' },
      sessionId: 'session-9',
    })
    const client = new RecordingSqlClient()
    const store = makeStore(client)
    const attempt = claimOf({ idempotencyKey: rawKey })

    expect(await store.claim(attempt)).toEqual({ status: 'accepted' })
    expect(await store.claim(attempt)).toEqual({ status: 'replayed', attempt })
    expect(await store.settle(settleOf({ idempotencyKey: rawKey }))).toEqual({ status: 'settled' })

    const parameters = JSON.stringify(client.runs.flatMap((run) => run.params))
    expect(parameters).not.toContain(rawKey)
    expect(parameters).not.toContain('visitor-123')
    expect(client.inspect('tenant-1', 'booking', storedKey('tenant-1', 'booking', rawKey))).toEqual(
      {
        ...IN_FLIGHT,
        idempotencyKey: storedKey('tenant-1', 'booking', rawKey),
        state: 'confirmed',
        providerId: 'BK-1',
      },
    )
  })

  test('no statement text carries a tenant id, a key or a fingerprint', async () => {
    const client = new RecordingSqlClient()
    const store = makeStore(client)
    await store.claim(claimOf({ fingerprint: 'fp-secret' }))
    await store.settle(settleOf())

    for (const sql of client.sql) {
      expect(sql).not.toContain('tenant-1')
      expect(sql).not.toContain('key-1')
      expect(sql).not.toContain('fp-secret')
    }
    expect(client.runs.flatMap((run) => run.params)).toEqual([
      'tenant-1',
      'booking',
      STORED_KEY,
      'fp-secret',
      'in_flight',
      'tenant-1',
      'booking',
      STORED_KEY,
      'in_flight',
      'confirmed',
      'BK-1',
    ])
  })

  test('the store names the database it was given, not itself', () => {
    const client = new RecordingSqlClient({ storeId: 'primary' })
    expect(makeStore(client).storeId).toBe('postgres(primary)')
  })
})
