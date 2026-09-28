/**
 * The email attempt store, against the recording fake.
 *
 * The email port's `settle` returns a `boolean` where the booking port returns
 * a `settled`/`stale` pair, so the two adapters cannot share assertions — but
 * they share the policy in `core.ts`, and this suite exists to show that the
 * shape difference does not become a behaviour difference.
 *
 * The load-bearing claim of this file is about `false`: it is the answer for a
 * lost CAS, for a database that would not answer, and for a row that does not
 * check out, and the port has no third value in which to tell them apart. So
 * the tests pin the two properties the port *can* have — `false` never means
 * "write this and it worked", and `true` is only ever returned after a
 * conditional `UPDATE` actually moved a row.
 *
 * What these tests do not prove, and neither does anything else in this
 * package without a database:
 *
 *   * that PostgreSQL accepted the SQL, or that a real unique index makes the
 *     claim atomic across processes (see the migration header and the Result's
 *     "remaining database verification");
 *   * that the outbox above would correctly refuse to send twice a message
 *     whose `settle` came back `false` — that is that boundary's property, and
 *     this package's job is only to make `false` the honest answer;
 *   * that any message was or was not delivered. Nothing here talks to a
 *     transport.
 */

import { describe, expect, test } from 'vitest'

import type { EmailAttemptRecord, EmailAttemptSettlement } from '@archava/act-email'
import { EMAIL_ACTION_KIND, PostgresEmailAttemptStore } from '../src/email-store.js'
import { attemptStorageKey } from '../src/storage-key.js'
import { RecordingSqlClient, type StoredAttempt } from './recording-sql-client.js'

const STORAGE_SECRET = new Uint8Array(32).fill(7)
const storedKey = (tenantId = 'tenant-1', actionKind = EMAIL_ACTION_KIND, rawKey = 'key-1') =>
  attemptStorageKey(STORAGE_SECRET, tenantId, actionKind, rawKey)
const STORED_KEY = storedKey()

function makeStore(client: RecordingSqlClient): PostgresEmailAttemptStore {
  return new PostgresEmailAttemptStore({ client, idempotencyKeyHmacKey: STORAGE_SECRET })
}

const PREPARED: StoredAttempt = {
  tenantId: 'tenant-1',
  actionKind: EMAIL_ACTION_KIND,
  idempotencyKey: STORED_KEY,
  fingerprint: 'fp-1',
  state: 'prepared',
  providerId: null,
}

function claimOf(overrides: Partial<EmailAttemptRecord> = {}): EmailAttemptRecord {
  return {
    tenantId: 'tenant-1',
    idempotencyKey: 'key-1',
    fingerprint: 'fp-1',
    state: 'prepared',
    ...overrides,
  }
}

function settleOf(overrides: Partial<EmailAttemptSettlement> = {}): EmailAttemptSettlement {
  return {
    tenantId: 'tenant-1',
    idempotencyKey: 'key-1',
    from: 'prepared',
    state: 'accepted',
    providerMessageId: 'msg-1',
    ...overrides,
  }
}

describe('claim', () => {
  test('a fresh key is claimed with one insert-or-nothing, opened as prepared', async () => {
    const client = new RecordingSqlClient()
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({ status: 'accepted' })

    expect(client.only.params).toEqual(['tenant-1', 'email', STORED_KEY, 'fp-1', 'prepared'])
    expect(client.inspect('tenant-1', 'email', STORED_KEY)).toEqual(PREPARED)
  })

  test('a key somebody sent is replayed with the provider’s message id', async () => {
    const client = new RecordingSqlClient({
      seed: [{ ...PREPARED, state: 'accepted', providerId: 'msg-9' }],
    })
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({
      status: 'replayed',
      attempt: {
        tenantId: 'tenant-1',
        idempotencyKey: 'key-1',
        fingerprint: 'fp-1',
        state: 'accepted',
        providerMessageId: 'msg-9',
      },
    })
    expect(client.sql.filter((sql) => sql.includes('INSERT'))).toHaveLength(1)
  })

  test('the same key under another tenant is a different attempt', async () => {
    const client = new RecordingSqlClient({ seed: [PREPARED] })
    const store = makeStore(client)

    expect(await store.claim(claimOf({ tenantId: 'tenant-2' }))).toEqual({ status: 'accepted' })
    expect(client.inspect('tenant-1', 'email', STORED_KEY)).toEqual(PREPARED)
  })

  test('the same key under the booking action kind is a different attempt', async () => {
    const client = new RecordingSqlClient({
      seed: [
        {
          ...PREPARED,
          actionKind: 'booking',
          idempotencyKey: storedKey('tenant-1', 'booking'),
          state: 'in_flight',
        },
      ],
    })
    const store = makeStore(client)

    expect(await store.claim(claimOf())).toEqual({ status: 'accepted' })
    expect(client.inspect('tenant-1', 'booking', storedKey('tenant-1', 'booking'))?.state).toBe(
      'in_flight',
    )
  })

  test('a database that would not answer is a throw, so the outbox reports unknown', async () => {
    const store = new PostgresEmailAttemptStore({
      client: new RecordingSqlClient({ failFromCall: 0 }),
      idempotencyKeyHmacKey: STORAGE_SECRET,
    })

    await expect(store.claim(claimOf())).rejects.toThrow(/email_attempt_store_unavailable/)
  })

  test('a row that does not check out is refused, not reported as a record', async () => {
    const client = new RecordingSqlClient({ seed: [{ ...PREPARED, state: 'perhaps' }] })
    const store = makeStore(client)

    await expect(store.claim(claimOf())).rejects.toThrow(/email_attempt_row_state_unknown/)
  })
})

describe('settle', () => {
  test('an acceptance is written once and answered true', async () => {
    const client = new RecordingSqlClient({ seed: [PREPARED] })
    const store = makeStore(client)

    expect(await store.settle(settleOf())).toBe(true)

    expect(client.only.params).toEqual([
      'tenant-1',
      'email',
      STORED_KEY,
      'prepared',
      'accepted',
      'msg-1',
    ])
    expect(client.inspect('tenant-1', 'email', STORED_KEY)).toEqual({
      ...PREPARED,
      state: 'accepted',
      providerId: 'msg-1',
    })
  })

  test('a rejection is written on the same path and answered true', async () => {
    const client = new RecordingSqlClient({ seed: [PREPARED] })
    const store = makeStore(client)

    expect(await store.settle(settleOf({ state: 'rejected', providerMessageId: undefined }))).toBe(
      true,
    )
    expect(client.only.params[5]).toBeNull()
  })

  test('nobody knowing is a real state, not an error', async () => {
    const client = new RecordingSqlClient({ seed: [PREPARED] })
    const store = makeStore(client)

    expect(await store.settle(settleOf({ state: 'unknown', providerMessageId: undefined }))).toBe(
      true,
    )
    expect(client.inspect('tenant-1', 'email', STORED_KEY)?.state).toBe('unknown')
  })

  test('a second writer after the provider answered is told false, not true', async () => {
    const client = new RecordingSqlClient({ seed: [PREPARED] })
    const store = makeStore(client)

    expect(await store.settle(settleOf())).toBe(true)
    // A late refusal for the same key: the CAS no longer matches.
    expect(await store.settle(settleOf({ state: 'rejected', providerMessageId: undefined }))).toBe(
      false,
    )

    expect(client.inspect('tenant-1', 'email', STORED_KEY)).toEqual({
      ...PREPARED,
      state: 'accepted',
      providerId: 'msg-1',
    })
  })

  test('a database that would not answer is false and never true', async () => {
    const store = new PostgresEmailAttemptStore({
      client: new RecordingSqlClient({ seed: [PREPARED], failFromCall: 0 }),
      idempotencyKeyHmacKey: STORAGE_SECRET,
    })

    expect(await store.settle(settleOf())).toBe(false)
  })

  test('a row that does not check out is false, not silently settled', async () => {
    const client = new RecordingSqlClient({
      seed: [{ ...PREPARED, state: 'accepted', providerId: '' }],
    })
    const store = makeStore(client)

    expect(await store.settle(settleOf())).toBe(false)
  })
})

describe('what is never stored', () => {
  test('the raw input-bearing key stays out of SQL and the durable row', async () => {
    const rawKey = JSON.stringify({ inputs: { recipient: 'person@example.test' }, sessionId: 's9' })
    const client = new RecordingSqlClient()
    const store = makeStore(client)
    const attempt = claimOf({ idempotencyKey: rawKey })

    expect(await store.claim(attempt)).toEqual({ status: 'accepted' })
    expect(await store.claim(attempt)).toEqual({ status: 'replayed', attempt })
    expect(await store.settle(settleOf({ idempotencyKey: rawKey }))).toBe(true)

    const parameters = JSON.stringify(client.runs.flatMap((run) => run.params))
    expect(parameters).not.toContain(rawKey)
    expect(parameters).not.toContain('person@example.test')
    expect(client.inspect('tenant-1', 'email', storedKey('tenant-1', 'email', rawKey))).toEqual({
      ...PREPARED,
      idempotencyKey: storedKey('tenant-1', 'email', rawKey),
      state: 'accepted',
      providerId: 'msg-1',
    })
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
  })

  test('the whole bound payload is the identity, the digest, two states and the id', async () => {
    const client = new RecordingSqlClient()
    const store = makeStore(client)
    await store.claim(claimOf())
    await store.settle(settleOf())

    expect(client.runs.flatMap((run) => run.params)).toEqual([
      'tenant-1',
      'email',
      STORED_KEY,
      'fp-1',
      'prepared',
      'tenant-1',
      'email',
      STORED_KEY,
      'prepared',
      'accepted',
      'msg-1',
    ])
  })

  test('the store names the database it was given, not itself', () => {
    const client = new RecordingSqlClient({ storeId: 'primary' })
    expect(makeStore(client).storeId).toBe('postgres(primary)')
  })
})
