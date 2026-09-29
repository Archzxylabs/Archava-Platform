/**
 * The store, as a promise to the service.
 *
 * Everything the port guarantees about a confirmation being spent at most once is
 * tested here against the recording fake, which replays PostgreSQL's predicate
 * semantics rather than assuming them. Each test names the production change that
 * would make it fail: a store that read before writing, that bound the tenant id
 * into SQL text, that treated a zero-row transition as a spend, that reported a
 * mismatch as "no such challenge", or that let a client rejection look like a
 * verdict.
 *
 * The distinction this suite keeps intact above all others is **spent vs
 * refused**. A store that answers `spent` for a row it did not transition is the
 * failure the whole port exists to prevent, so every transition test asserts on
 * the row the fake holds and not only on the answer it returned.
 *
 * ## What this suite cannot prove
 *
 * The fake is one process and one `Map`: its two-consumer test proves the store
 * never invents a second transition, not that PostgreSQL serializes two real
 * connections. It cannot prove PostgreSQL accepts the SQL, that the primary key
 * is really enforced, or that a write survived a restart. Those belong to
 * `scripts/verify-against-postgres.ts`, which needs local tools and no network.
 */

import { describe, expect, test } from 'vitest'

import type { ConfirmationChallengeConsumption } from '@archava/act-confirmation'
import { PostgresChallengeStore } from '../src/postgres-challenge-store.js'
import type { StoredChallenge } from './recording-sql-client.js'
import { RecordingSqlClient } from './recording-sql-client.js'

const DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = 'b'.repeat(64)

const INSERT = {
  id: 'challenge-1',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  actionId: 'action-1',
  tokenDigest: DIGEST,
  bindingDigest: OTHER_DIGEST,
  issuedAt: 1770000000000,
  expiresAt: 1770000300000,
} as const

const NOW = 1770000123000

const PRESENTATION: ConfirmationChallengeConsumption = {
  id: INSERT.id,
  tenantId: INSERT.tenantId,
  sessionId: INSERT.sessionId,
  actionId: INSERT.actionId,
  tokenDigest: INSERT.tokenDigest,
  bindingDigest: INSERT.bindingDigest,
  now: NOW,
}

/** The row `issue` writes, as a seed for tests that start from a stored state. */
function stored(overrides: Readonly<Partial<StoredChallenge>> = {}): StoredChallenge {
  return {
    id: INSERT.id,
    tenantId: INSERT.tenantId,
    sessionId: INSERT.sessionId,
    actionId: INSERT.actionId,
    tokenDigest: INSERT.tokenDigest,
    bindingDigest: INSERT.bindingDigest,
    state: 'pending',
    issuedAt: INSERT.issuedAt,
    expiresAt: INSERT.expiresAt,
    consumedAt: null,
    ...overrides,
  }
}

describe('PostgresChallengeStore.issue', () => {
  test('reports success and leaves the row pending', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)

    await expect(store.issue(INSERT)).resolves.toBe(true)
    expect(client.inspect(INSERT.id)).toEqual(stored())
  })

  test('reports a colliding id as false, because the insert happened and inserted nothing', async () => {
    // Two issuers of one id: the loser gets zero rows back rather than an error,
    // and `false` is a claim about the id rather than about the database.
    const client = new RecordingSqlClient({ seed: [stored()] })
    const store = new PostgresChallengeStore(client)

    await expect(store.issue(INSERT)).resolves.toBe(false)
    expect(client.only.sql).toContain('ON CONFLICT (id) DO NOTHING')
  })

  test('rewrites nothing when the id is taken, so a collision cannot overwrite a challenge', async () => {
    const client = new RecordingSqlClient({
      seed: [stored({ tokenDigest: DIGEST, consumedAt: NOW, state: 'consumed' })],
    })
    const store = new PostgresChallengeStore(client)

    await expect(store.issue(INSERT)).resolves.toBe(false)
    expect(client.inspect(INSERT.id)?.state).toBe('consumed')
    expect(client.inspect(INSERT.id)?.consumedAt).toBe(NOW)
  })

  test('throws rather than answering false when the answer is unknown', async () => {
    // The service turns `false` into "the id is taken" and a thrown error into
    // "the store is unavailable". A client error collapsed into `false` would
    // make an outage look like an id collision.
    const client = new RecordingSqlClient({ failFromCall: 0 })
    const store = new PostgresChallengeStore(client)

    await expect(store.issue(INSERT)).rejects.toThrow()
  })

  test.each(['multiple_rows', 'wrong_id', 'malformed_row'] as const)(
    'refuses a broken INSERT RETURNING response: %s',
    async (insertOutcome) => {
      const store = new PostgresChallengeStore(new RecordingSqlClient({ insertOutcome }))
      await expect(store.issue(INSERT)).rejects.toThrow('issue_returning_unreadable')
    },
  )

  test('refuses a non-integer instant before any statement runs, so no row can be born expired', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)

    await expect(store.issue({ ...INSERT, expiresAt: INSERT.issuedAt })).rejects.toThrow()
    await expect(store.issue({ ...INSERT, issuedAt: Number.NaN })).rejects.toThrow()
    expect(client.runCount).toBe(0)
  })
})

describe('PostgresChallengeStore.consume', () => {
  test('spends one matching pending challenge and stamps the supplied instant', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    const result = await store.consume(PRESENTATION)

    expect(result.status).toBe('spent')
    if (result.status !== 'spent') return
    expect(result.challenge.state).toBe('consumed')
    expect(result.challenge.consumedAt).toBe(NOW)
    expect(client.inspect(INSERT.id)?.state).toBe('consumed')
    expect(client.inspect(INSERT.id)?.consumedAt).toBe(NOW)
  })

  test('decides and writes in one statement, so a read cannot race the transition', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)
    const before = client.runCount

    await store.consume(PRESENTATION)

    // Exactly one statement, and it is the conditional update — not a SELECT
    // followed by a write. Read-then-write is the shape two concurrent
    // presentations can both complete, which is how a consent gets spent twice.
    expect(client.runCount - before).toBe(1)
    expect(client.runs.at(-1)?.sql).toContain('UPDATE confirmation_challenges')
    // A row marked consumed without its instant, or stamped without being
    // marked, is a row the service cannot reconcile. Both are in the SET clause,
    // so both move together.
    expect(client.runs.at(-1)?.sql).toContain("state = 'consumed',")
    expect(client.runs.at(-1)?.sql).toContain('consumed_at = $2')
  })

  test('binds the tenant, session, action and both digests as parameters, in predicate order', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    await store.consume(PRESENTATION)

    const transition = client.runs.at(-1)
    // A tenant id that appears in the statement text is a tenant id that could be
    // SQL. It is only ever a `$n`, which is why the text cannot carry one.
    expect(transition?.sql).not.toContain('tenant-1')
    expect(transition?.sql).not.toContain(DIGEST)
    expect(transition?.params).toEqual([
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

  test('compares the supplied instant against the stored window, never the database clock', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    await store.consume(PRESENTATION)

    expect(client.runs.at(-1)?.sql).toContain('AND $8 >= issued_at')
    expect(client.runs.at(-1)?.sql).toContain('AND $9 < expires_at')
    expect(client.runs.at(-1)?.sql).not.toContain('now()')
  })

  test('reports a replay as already consumed, and leaves the first stamp alone', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)
    await store.consume(PRESENTATION)

    const replay = await store.consume(PRESENTATION)

    expect(replay.status).toBe('already_consumed')
    expect(client.inspect(INSERT.id)?.consumedAt).toBe(NOW)
  })

  test('never spends a challenge presented by another tenant, session or action', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    for (const wrong of [
      { tenantId: 'tenant-2' },
      { sessionId: 'session-2' },
      { actionId: 'action-2' },
      { tokenDigest: 'c'.repeat(64) },
      { bindingDigest: 'd'.repeat(64) },
    ]) {
      const result = await store.consume({ ...PRESENTATION, ...wrong })
      expect(result.status).toBe('mismatch')
    }

    expect(client.inspect(INSERT.id)?.state).toBe('pending')
  })

  test('scopes the classification lookup to the id alone, so another tenant’s row is found and refused', async () => {
    // If the SELECT carried the tenant, a cross-tenant presentation would come
    // back "no such challenge" — which is the one answer the port forbids for a
    // challenge that exists. It must come back 'mismatch' instead.
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    const result = await store.consume({ ...PRESENTATION, tenantId: 'tenant-2' })

    expect(result.status).toBe('mismatch')
    const lookup = client.runs.at(-1)?.sql ?? ''
    expect(lookup).toContain('WHERE id = $1')
    expect(lookup).not.toContain('tenant_id =')
    expect(lookup).not.toContain('session_id =')
  })

  test('tells a mismatch from a missing challenge', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    expect((await store.consume({ ...PRESENTATION, tenantId: 'tenant-2' })).status).toBe('mismatch')
    expect((await store.consume({ ...PRESENTATION, id: 'challenge-absent' })).status).toBe(
      'not_found',
    )
  })

  test('spends a challenge presented at the last instant inside its window', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    const result = await store.consume({ ...PRESENTATION, now: INSERT.expiresAt - 1 })

    expect(result.status).toBe('spent')
    expect(client.inspect(INSERT.id)?.state).toBe('consumed')
  })

  test('reports a presentation at or past the expiry as expired, without spending it', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    expect((await store.consume({ ...PRESENTATION, now: INSERT.expiresAt })).status).toBe('expired')
    expect((await store.consume({ ...PRESENTATION, now: INSERT.expiresAt + 1 })).status).toBe(
      'expired',
    )
    expect(client.inspect(INSERT.id)?.state).toBe('pending')
  })

  test('tells a replay past the window it was spent inside from an expired one', async () => {
    // The window governs whether a challenge *could* be spent, not whether it
    // was. A row stamped inside it is already consumed however late the replay
    // lands, so the lookup has to answer `already_consumed` where the predicate
    // on its own could only have said nothing.
    const client = new RecordingSqlClient({
      seed: [stored({ state: 'consumed', consumedAt: NOW })],
    })
    const store = new PostgresChallengeStore(client)

    const result = await store.consume({ ...PRESENTATION, now: INSERT.expiresAt + 1 })

    expect(result).toEqual(expect.objectContaining({ status: 'already_consumed' }))
    expect(client.inspect(INSERT.id)?.consumedAt).toBe(NOW)
  })

  test('refuses an instant it cannot read without spending anything', async () => {
    // A fractional `now` would compare against an instant the service's own
    // arithmetic has no way to produce, and a spend at one is irreconcilable.
    const client = new RecordingSqlClient({ seed: [stored()] })
    const store = new PostgresChallengeStore(client)

    const result = await store.consume({ ...PRESENTATION, now: 1770000123.5 })

    expect(result).toEqual(expect.objectContaining({ status: 'unavailable' }))
    expect(client.inspect(INSERT.id)?.state).toBe('pending')
  })

  test('does not burn a challenge when the caller clock is before issuance', async () => {
    const client = new RecordingSqlClient({ seed: [stored()] })
    const store = new PostgresChallengeStore(client)

    const result = await store.consume({ ...PRESENTATION, now: INSERT.issuedAt - 1 })

    expect(result.status).not.toBe('spent')
    expect(client.inspect(INSERT.id)?.state).toBe('pending')
    expect(client.runs[0]?.sql).toContain('AND $8 >= issued_at')
  })

  test('spends the same row however the driver renders its bigint columns', async () => {
    // `pg` returns bigint as a string unless a type parser is installed, and a
    // deployment's answer must not depend on which one it has. The identities and
    // digests are text either way; only the three instants change shape.
    const client = new RecordingSqlClient({ readBigintsAs: 'string' })
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    const result = await store.consume(PRESENTATION)

    expect(result.status).toBe('spent')
    if (result.status !== 'spent') return
    expect(result.challenge.issuedAt).toBe(INSERT.issuedAt)
    expect(result.challenge.expiresAt).toBe(INSERT.expiresAt)
    expect(result.challenge.consumedAt).toBe(NOW)
  })
})

describe('PostgresChallengeStore.consume under concurrency', () => {
  test('two consumers of one challenge produce exactly one spend', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    const settled = await Promise.all([store.consume(PRESENTATION), store.consume(PRESENTATION)])

    expect(settled.filter((answer) => answer.status === 'spent')).toHaveLength(1)
    expect(settled.filter((answer) => answer.status === 'already_consumed')).toHaveLength(1)
    expect(client.inspect(INSERT.id)?.consumedAt).toBe(NOW)
  })

  test('never lets a consumer believe it spent a row another consumer spent', async () => {
    const client = new RecordingSqlClient()
    const store = new PostgresChallengeStore(client)
    await store.issue(INSERT)

    const settled = await Promise.all([
      store.consume(PRESENTATION),
      store.consume(PRESENTATION),
      store.consume(PRESENTATION),
    ])

    // Only the statement that actually transitioned the row may claim a spend;
    // the others are replays or refusals, and none of them re-stamps the row.
    expect(settled.filter((answer) => answer.status === 'spent')).toHaveLength(1)
    expect(settled.map((answer) => answer.status).sort()).toEqual([
      'already_consumed',
      'already_consumed',
      'spent',
    ])
  })
})

describe('PostgresChallengeStore.consume failing closed', () => {
  test('reports unavailable when the write rejects, and issues no second statement', async () => {
    // A rejection means "nobody knows what happened". Reporting anything else
    // would tell one presentation it failed while another succeeded.
    const client = new RecordingSqlClient({ failFromCall: 0 })
    const store = new PostgresChallengeStore(client)

    await expect(store.consume(PRESENTATION)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    )
    expect(client.runCount).toBe(1)
  })

  test('reports unavailable when the zero rows could not be classified either', async () => {
    const client = new RecordingSqlClient({ failFromCall: 1 })
    const store = new PostgresChallengeStore(client)

    const result = await store.consume({ ...PRESENTATION, id: 'challenge-absent' })

    expect(result).toEqual(expect.objectContaining({ status: 'unavailable' }))
    expect(client.runCount).toBe(2)
  })

  test('reports unavailable when the transition returned two rows for one id', async () => {
    const client = new RecordingSqlClient({ updateOutcome: 'multiple_rows' })
    const store = new PostgresChallengeStore(client)

    await expect(store.consume(PRESENTATION)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    )
  })

  test('reports unavailable when the spent row does not validate', async () => {
    const client = new RecordingSqlClient({ updateOutcome: 'malformed_row' })
    const store = new PostgresChallengeStore(client)

    await expect(store.consume(PRESENTATION)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    )
  })

  test.each(['pending_row', 'wrong_tenant', 'wrong_timestamp'] as const)(
    'reports unavailable when UPDATE RETURNING does not describe the requested spend: %s',
    async (updateOutcome) => {
      const store = new PostgresChallengeStore(new RecordingSqlClient({ updateOutcome }))
      await expect(store.consume(PRESENTATION)).resolves.toEqual(
        expect.objectContaining({ status: 'unavailable' }),
      )
    },
  )

  test('reports unavailable when the lookup returned two rows for one id', async () => {
    const client = new RecordingSqlClient({
      seed: [stored({ state: 'consumed', consumedAt: NOW })],
      lookupOutcome: 'multiple_rows',
    })
    const store = new PostgresChallengeStore(client)

    await expect(store.consume(PRESENTATION)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    )
  })

  test('reports unavailable when the lookup row does not validate', async () => {
    const client = new RecordingSqlClient({
      seed: [stored({ state: 'consumed', consumedAt: NOW })],
      lookupOutcome: 'malformed_row',
    })
    const store = new PostgresChallengeStore(client)

    await expect(store.consume(PRESENTATION)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    )
  })

  test('reports unavailable when a matching pending challenge was left unspent', async () => {
    // A pending, matching, unexpired row after a zero-row transition is not a
    // spend and not a verdict either: the store cannot explain the zero rows,
    // and guessing which of replay, mismatch or outage it was would be worse
    // than refusing.
    const client = new RecordingSqlClient({ seed: [stored()], updateOutcome: 'no_rows' })
    const store = new PostgresChallengeStore(client)

    await expect(store.consume(PRESENTATION)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    )
    expect(client.inspect(INSERT.id)?.state).toBe('pending')
  })
})
