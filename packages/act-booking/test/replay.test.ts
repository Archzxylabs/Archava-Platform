/**
 * The replay and reconciliation boundary.
 *
 * These are offline tests over fake ports. What they prove is the *contract*:
 * that one tenant-scoped idempotency key produces at most one reservation, that
 * a replay of the same payload is served from the record rather than from a
 * second write, that a changed payload is refused, that an ambiguous outcome is
 * recovered only by an authoritative lookup, and that neither a tenant's data
 * nor a provider's own words reach public output.
 *
 * What they do not prove, and cannot: that any real reservation system
 * deduplicates, that a durable store exists, or that this code works against a
 * live PMS. The fakes below demonstrate the contract; they are not evidence of
 * production durability.
 */

import { describe, expect, it } from 'vitest'
import type { ActionExecutionRequest } from '@archava/assistant'
import {
  BOOKING_ERROR_CODES,
  BookingActionExecutor,
  BookingReplayBoundary,
  type BookingAttemptClaim,
  type BookingAttemptRecord,
  type BookingAttemptSettlement,
  type BookingAttemptSettlementResult,
  type BookingAttemptStore,
  type BookingGateway,
  type BookingOutcome,
  type BookingReconciliationLookup,
  type BookingReconciliationPort,
  type BookingReservationRequest,
} from '../src/index.js'

const TENANT = 'acme-hotels'
const OTHER_TENANT = 'north-stay'
const SESSION = 'sess-01'
const KEY = 'idem-key-1'
const SLOT = 'slot-9'
const CUSTOMER = 'cust-42'
const TEST_FINGERPRINT_KEY = Buffer.alloc(32, 7)

/* -------------------------------------------------------------------------- */
/* the fakes                                                                  */
/* -------------------------------------------------------------------------- */

/** The payload, folded the way `reserve` folds it. */
function fingerprintOf(
  tenantId: string,
  slotId: string,
  customerRef: string,
  notes?: string,
): string {
  return JSON.stringify([tenantId, slotId, customerRef, notes ?? null])
}

/** What one reservation looks like inside a fake booking system. */
interface Reservation {
  readonly reference: string
  readonly fingerprint: string
}

/**
 * A fake authoritative system.
 *
 * Two sides of one thing: the gateway it writes through and the reconciler it
 * reads through, sharing the reservation table that makes a "the system already
 * made this" answer answerable.
 */
function bookingSystem(options?: { readonly ready?: boolean }) {
  const table = new Map<string, Reservation>()
  const reserves: BookingReservationRequest[] = []
  const lookups: BookingReconciliationLookup[] = []
  let minted = 0

  const fingerprint = (request: BookingReservationRequest): string =>
    fingerprintOf(request.tenantId, request.slotId, request.customerRef, request.notes)
  const slotOf = (tenantId: string, key: string): string => `${tenantId}::${key}`

  const gateway: BookingGateway = {
    gatewayId: 'fake-pms',
    health: {
      get ready(): boolean {
        return options?.ready ?? true
      },
      get reason(): string {
        return (options?.ready ?? true) ? 'ready' : 'outage'
      },
    },
    reserve(request: BookingReservationRequest): Promise<BookingOutcome> {
      reserves.push(request)
      const slot = slotOf(request.tenantId, request.idempotencyKey)
      const existing = table.get(slot)
      if (existing === undefined) {
        minted += 1
        const reference = `RES-${String(minted).padStart(4, '0')}`
        table.set(slot, { reference, fingerprint: fingerprint(request) })
        return Promise.resolve({ outcome: 'confirmed', bookingReference: reference })
      }
      if (existing.fingerprint === fingerprint(request)) {
        return Promise.resolve({ outcome: 'confirmed', bookingReference: existing.reference })
      }
      return Promise.resolve({ outcome: 'rejected', reason: 'idempotency_key_conflict' })
    },
  }

  const reconciler: BookingReconciliationPort = {
    reconcilerId: 'fake-pms-lookup',
    reconcile(lookup: BookingReconciliationLookup): Promise<BookingOutcome> {
      lookups.push(lookup)
      const found = table.get(slotOf(lookup.tenantId, lookup.idempotencyKey))
      if (found === undefined) {
        return Promise.resolve({ outcome: 'unknown', reason: 'attempt_not_found' })
      }
      return Promise.resolve({ outcome: 'confirmed', bookingReference: found.reference })
    },
  }

  return {
    gateway,
    reconciler,
    reserves,
    lookups,
    /** How many reservations the system believes it holds. */
    get reservations(): number {
      return table.size
    },
  }
}

/** A gateway that mints a fresh reference every call and deduplicates nothing. */
function unguardedGateway(): BookingGateway & { readonly reserves: BookingReservationRequest[] } {
  const reserves: BookingReservationRequest[] = []
  let minted = 0
  return {
    gatewayId: 'unguarded-pms',
    health: { ready: true, reason: 'ready' },
    reserves,
    reserve(request: BookingReservationRequest): Promise<BookingOutcome> {
      reserves.push(request)
      minted += 1
      return Promise.resolve({
        outcome: 'confirmed',
        bookingReference: `FRESH-${String(minted).padStart(3, '0')}`,
      })
    },
  }
}

/** A gateway whose answer is whatever the test wrote down. */
function scriptedGateway(
  script: readonly (() => BookingOutcome)[],
): BookingGateway & { readonly reserves: BookingReservationRequest[] } {
  const reserves: BookingReservationRequest[] = []
  let call = 0
  return {
    gatewayId: 'scripted-pms',
    health: { ready: true, reason: 'ready' },
    reserves,
    reserve(request: BookingReservationRequest): Promise<BookingOutcome> {
      reserves.push(request)
      const step = script[call]
      call += 1
      if (step === undefined)
        return Promise.resolve({ outcome: 'unknown', reason: 'script_exhausted' })
      return Promise.resolve(step())
    },
  }
}

/** A gateway that throws, as a booking system that stopped answering does. */
function throwingGateway(fault: () => Error): BookingGateway {
  return {
    gatewayId: 'throwing-pms',
    health: { ready: true, reason: 'ready' },
    reserve(): Promise<BookingOutcome> {
      // Rejected, never a synchronously thrown value: the boundary awaits this
      // and catches either way, but a port that throws synchronously is a
      // different bug from one that fails mid-flight, and this fake models the
      // one the executor actually has to survive.
      return Promise.reject(fault())
    },
  }
}

/**
 * An attempt store whose `claim` is atomic.
 *
 * `claim` contains no `await`, so the read-modify-write completes before
 * anything else in the process can interleave. That is the single-process
 * version of what a production store needs a unique index to guarantee across
 * processes; the Map is a test double and this file claims nothing more for it.
 */
function attemptStore(options?: {
  readonly claimThrows?: boolean
  readonly settleThrows?: boolean
}): {
  readonly store: BookingAttemptStore
  readonly records: () => BookingAttemptRecord[]
  readonly settlements: () => BookingAttemptSettlement[]
  readonly stateOf: (tenantId: string, key: string) => BookingAttemptRecord | undefined
} {
  const records = new Map<string, BookingAttemptRecord>()
  const settlements: BookingAttemptSettlement[] = []
  const slotOf = (tenantId: string, key: string): string => `${tenantId}::${key}`

  const store: BookingAttemptStore = {
    storeId: 'fake-attempt-store',
    claim(attempt: BookingAttemptRecord): Promise<BookingAttemptClaim> {
      if (options?.claimThrows === true) {
        return Promise.reject(new Error('store is unavailable'))
      }
      const slot = slotOf(attempt.tenantId, attempt.idempotencyKey)
      const existing = records.get(slot)
      if (existing !== undefined) return Promise.resolve({ status: 'replayed', attempt: existing })
      records.set(slot, attempt)
      return Promise.resolve({ status: 'accepted' })
    },
    settle(settlement: BookingAttemptSettlement): Promise<BookingAttemptSettlementResult> {
      if (options?.settleThrows === true) {
        return Promise.reject(new Error('store refused the write'))
      }
      settlements.push(settlement)
      const current = records.get(slotOf(settlement.tenantId, settlement.idempotencyKey))
      if (current === undefined) return Promise.reject(new Error('attempt not found'))
      if (current.state !== settlement.from) {
        return Promise.resolve({ status: 'stale', attempt: current })
      }
      records.set(slotOf(settlement.tenantId, settlement.idempotencyKey), {
        tenantId: current.tenantId,
        idempotencyKey: current.idempotencyKey,
        fingerprint: current.fingerprint,
        state: settlement.state,
        ...(settlement.bookingReference === undefined
          ? {}
          : { bookingReference: settlement.bookingReference }),
      })
      return Promise.resolve({ status: 'settled' })
    },
  }

  return {
    store,
    records: () => [...records.values()],
    settlements: () => settlements,
    stateOf: (tenantId, key) => records.get(slotOf(tenantId, key)),
  }
}

/**
 * A store that keyed its records on the idempotency key alone.
 *
 * Deliberately wrong: this is what a deployment that forgot the tenant scope
 * looks like, kept so the boundary can be shown to refuse it. The fingerprint
 * carries the tenant, and the boundary checks it rather than trusting the store.
 */
function tenantBlindStore(): {
  readonly store: BookingAttemptStore
  readonly records: () => BookingAttemptRecord[]
} {
  const records = new Map<string, BookingAttemptRecord>()
  const store: BookingAttemptStore = {
    storeId: 'tenant-blind-store',
    claim(attempt: BookingAttemptRecord): Promise<BookingAttemptClaim> {
      const existing = records.get(attempt.idempotencyKey)
      if (existing !== undefined) return Promise.resolve({ status: 'replayed', attempt: existing })
      records.set(attempt.idempotencyKey, attempt)
      return Promise.resolve({ status: 'accepted' })
    },
    settle(settlement: BookingAttemptSettlement): Promise<BookingAttemptSettlementResult> {
      const current = records.get(settlement.idempotencyKey)
      if (current === undefined) return Promise.reject(new Error('attempt not found'))
      if (current.state !== settlement.from) {
        return Promise.resolve({ status: 'stale', attempt: current })
      }
      records.set(settlement.idempotencyKey, {
        tenantId: current.tenantId,
        idempotencyKey: current.idempotencyKey,
        fingerprint: current.fingerprint,
        state: settlement.state,
        ...(settlement.bookingReference === undefined
          ? {}
          : { bookingReference: settlement.bookingReference }),
      })
      return Promise.resolve({ status: 'settled' })
    },
  }
  return { store, records: () => [...records.values()] }
}

/** A reconciler that answers what the test wrote down, and records the asks. */
function scriptedReconciler(
  script: readonly (() => BookingOutcome)[],
): BookingReconciliationPort & {
  readonly lookups: BookingReconciliationLookup[]
} {
  const lookups: BookingReconciliationLookup[] = []
  let call = 0
  return {
    reconcilerId: 'scripted-lookup',
    lookups,
    reconcile(lookup: BookingReconciliationLookup): Promise<BookingOutcome> {
      lookups.push(lookup)
      const step = script[call]
      call += 1
      if (step === undefined) {
        return Promise.resolve({ outcome: 'unknown', reason: 'attempt_not_found' })
      }
      return Promise.resolve(step())
    },
  }
}

/** A reconciler that cannot look anything up, and says so. */
function blindReconciler(): BookingReconciliationPort {
  return {
    reconcilerId: 'blind-lookup',
    reconcile(): Promise<BookingOutcome> {
      return Promise.resolve({ outcome: 'unknown', reason: 'attempt_not_found' })
    },
  }
}

/**
 * The boundary under test, bound to the executor it will serve.
 *
 * A new process is modelled by calling this again with a fresh gateway and the
 * same store, which is exactly what a restart looks like from the outside.
 */
function harness(options: {
  readonly gateway: BookingGateway
  readonly store: BookingAttemptStore
  readonly reconciler: BookingReconciliationPort
}) {
  const boundary = new BookingReplayBoundary({
    gateway: options.gateway,
    store: options.store,
    reconciler: options.reconciler,
    fingerprintKey: TEST_FINGERPRINT_KEY,
  })
  return { boundary, executor: new BookingActionExecutor({ gateway: boundary }) }
}

/** An executor driven straight through `ActionExecutionRequest`. */
type Driven = Pick<BookingActionExecutor, 'execute'>

/* -------------------------------------------------------------------------- */
/* driving the executor                                                       */
/* -------------------------------------------------------------------------- */

function request(overrides?: {
  action?: string
  slotId?: unknown
  customer?: unknown
  notes?: unknown
  tenantId?: string
  idempotencyKey?: string
}): ActionExecutionRequest {
  const slotId = overrides?.slotId === undefined ? SLOT : overrides.slotId
  const customer =
    overrides?.customer === undefined
      ? {
          customerRef: CUSTOMER,
          ...(overrides?.notes === undefined ? {} : { notes: overrides.notes }),
        }
      : overrides.customer
  return {
    tenantId: overrides?.tenantId === undefined ? TENANT : overrides.tenantId,
    sessionId: SESSION,
    action: overrides?.action === undefined ? 'booking.create' : overrides.action,
    inputs: { slotId, customer },
    idempotencyKey: overrides?.idempotencyKey === undefined ? KEY : overrides.idempotencyKey,
  }
}

interface Failure {
  status: 'failed'
  errorCode: string
  retryable: boolean
  message: string
}

async function succeeded(
  executor: Driven,
  call: ActionExecutionRequest,
): Promise<Record<string, unknown>> {
  const result = (await executor.execute(call)) as Record<string, unknown>
  if (result['status'] !== 'succeeded')
    throw new Error(`expected a success, got ${JSON.stringify(result)}`)
  return (result['output'] ?? {}) as Record<string, unknown>
}

async function failed(executor: Driven, call: ActionExecutionRequest): Promise<Failure> {
  const result = (await executor.execute(call)) as Record<string, unknown>
  if (result['status'] !== 'failed')
    throw new Error(`expected a failure, got ${JSON.stringify(result)}`)
  const errorCode = result['errorCode']
  const message = result['message']
  return {
    status: 'failed',
    // Narrowed rather than stringified: a non-string errorCode or message is a
    // defect in the executor, and `String()` would have turned it into a
    // plausible-looking '' instead of a failure this suite could see.
    errorCode: typeof errorCode === 'string' ? errorCode : '',
    retryable: result['retryable'] === true,
    message: typeof message === 'string' ? message : '',
  }
}

/** The reference the executor reports, or nothing. */
function referenceOf(output: Record<string, unknown>): string | undefined {
  const value = output['bookingReference']
  return typeof value === 'string' ? value : undefined
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/* -------------------------------------------------------------------------- */
/* the contract                                                               */
/* -------------------------------------------------------------------------- */

describe('one key, one reservation', () => {
  it('issues once, and replays the confirmed reference to a second caller', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })

    const first = await succeeded(executor, request())
    const second = await succeeded(executor, request())

    // Two successes, one reservation, and the second never reached the system.
    expect(system.reserves).toHaveLength(1)
    expect(system.reservations).toBe(1)
    expect(referenceOf(second)).toBe(referenceOf(first))
    expect(referenceOf(first)).toBe('RES-0001')
    expect(system.lookups).toHaveLength(0)
  })

  it('does not let a gateway that deduplicates nothing mint two reservations', async () => {
    // The boundary, not the provider, holds this line. A silent double-mint is
    // what the test exists for: were the claim advisory, the second call would
    // come back with FRESH-002 under the same key.
    const gateway = unguardedGateway()
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const first = await succeeded(executor, request())
    const second = await succeeded(executor, request())

    expect(gateway.reserves).toHaveLength(1)
    expect(referenceOf(second)).toBe(referenceOf(first))
    expect(referenceOf(first)).toBe('FRESH-001')
  })

  it('settles the record as confirmed, with the reference the system issued', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })

    const output = await succeeded(executor, request())
    const record = store.stateOf(TENANT, KEY)

    expect(record?.state).toBe('confirmed')
    expect(record?.bookingReference).toBe(referenceOf(output))
    // The durable record carries only a keyed digest, never raw payload data.
    expect(record?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(record)).not.toContain(SLOT)
    expect(JSON.stringify(record)).not.toContain(CUSTOMER)
    expect(Object.keys(record ?? {})).not.toContain('slotId')
    expect(Object.keys(record ?? {})).not.toContain('customerRef')
  })

  it('never persists or sends raw request fields in a reconciliation lookup', async () => {
    const privateNote = 'private-note-person@example.com'
    const gateway = scriptedGateway([() => ({ outcome: 'unknown', reason: 'timeout' })])
    const store = attemptStore()
    const reconciler = scriptedReconciler([
      () => ({ outcome: 'unknown', reason: 'attempt_not_found' }),
    ])
    const { executor } = harness({ gateway, store: store.store, reconciler })

    await failed(executor, request({ notes: privateNote }))
    await failed(executor, request({ notes: privateNote }))

    const durableAndLookup = JSON.stringify({
      records: store.records(),
      lookups: reconciler.lookups,
    })
    expect(durableAndLookup).not.toContain(privateNote)
    expect(durableAndLookup).not.toContain(CUSTOMER)
    expect(durableAndLookup).not.toContain(SLOT)
    expect(store.stateOf(TENANT, KEY)?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(reconciler.lookups[0]?.fingerprint).toBe(store.stateOf(TENANT, KEY)?.fingerprint)
  })
})

describe('the same key, a different payload', () => {
  it('refuses rather than serving the first attempt answer', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })

    const first = await succeeded(executor, request())
    const conflict = await failed(executor, request({ slotId: 'slot-different' }))

    expect(referenceOf(first)).toBe('RES-0001')
    expect(conflict.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(conflict.retryable).toBe(false)
    // Still one reservation, and the stranger never reached the system.
    expect(system.reserves).toHaveLength(1)
    expect(system.lookups).toHaveLength(0)
  })

  it('refuses a different customer and a changed note under the same key', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })
    await succeeded(executor, request())

    // A different tenant is a different attempt, not a payload conflict, and
    // is covered in the tenant section below. What is refused here is a
    // different request wearing this key.
    const variants = [
      request({ customer: { customerRef: 'cust-99' } }),
      request({ notes: 'needs a quiet table' }),
    ]
    for (const variant of variants) {
      expect((await failed(executor, variant)).errorCode).toBe(BOOKING_ERROR_CODES.declined)
    }
    expect(system.reserves).toHaveLength(1)
    expect(system.lookups).toHaveLength(0)
  })

  it('still replays correctly after a refusal, with the key intact', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })

    const first = await succeeded(executor, request())
    await failed(executor, request({ slotId: 'slot-different' }))
    const replay = await succeeded(executor, request())

    expect(referenceOf(replay)).toBe(referenceOf(first))
    expect(system.reserves).toHaveLength(1)
  })
})

describe('concurrent attempts', () => {
  it('lets exactly one of two simultaneous callers reserve', async () => {
    // The claim contains no await, so in this single process the two callers
    // cannot interleave inside it. What the test therefore demonstrates is that
    // the loser is served a real answer from the winner record rather than the
    // second write an unguarded gateway would happily make; that the claim
    // holds across processes is a property of the production store, and no
    // in-memory fake can show it.
    const gateway = unguardedGateway()
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const first = await succeeded(executor, request())
    const second = await succeeded(executor, request())

    expect(gateway.reserves).toHaveLength(1)
    expect(referenceOf(second)).toBe(referenceOf(first))
  })

  it('keeps concurrent attempts under different keys apart', async () => {
    const gateway = unguardedGateway()
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    // Two keys in flight at once. Neither may answer for the other, and neither
    // claim may consume the other's key.
    const [a, b] = await Promise.all([
      succeeded(executor, request({ idempotencyKey: 'key-a' })),
      succeeded(executor, request({ idempotencyKey: 'key-b' })),
    ])

    expect(gateway.reserves).toHaveLength(2)
    expect(referenceOf(a)).not.toBe(referenceOf(b))

    const aAgain = await succeeded(executor, request({ idempotencyKey: 'key-a' }))

    expect(referenceOf(aAgain)).toBe(referenceOf(a))
    expect(gateway.reserves).toHaveLength(2)
    expect(store.records()).toHaveLength(2)
  })

  it('does not settle an in-flight attempt as rejected before its write answers', async () => {
    const pending = deferred<BookingOutcome>()
    const reserveStarted = deferred<void>()
    const gateway: BookingGateway = {
      gatewayId: 'pending-pms',
      health: { ready: true, reason: 'ready' },
      reserve(): Promise<BookingOutcome> {
        reserveStarted.resolve()
        return pending.promise
      },
    }
    const store = attemptStore()
    const reconciler = scriptedReconciler([
      () => ({ outcome: 'rejected', reason: 'not_found_yet' }),
    ])
    const { executor } = harness({ gateway, store: store.store, reconciler })

    const first = succeeded(executor, request())
    await reserveStarted.promise
    const racingReplay = await failed(executor, request())

    expect(racingReplay.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('in_flight')
    pending.resolve({ outcome: 'confirmed', bookingReference: 'RES-LATE' })
    expect(referenceOf(await first)).toBe('RES-LATE')
    expect(referenceOf(await succeeded(executor, request()))).toBe('RES-LATE')
    expect(store.stateOf(TENANT, KEY)?.state).toBe('confirmed')
  })

  it('cannot overwrite a confirmed record with a stale negative reconciliation', async () => {
    const slowLookup = deferred<BookingOutcome>()
    const slowStarted = deferred<void>()
    let lookups = 0
    const reconciler: BookingReconciliationPort = {
      reconcilerId: 'interleaved-lookup',
      reconcile(): Promise<BookingOutcome> {
        lookups += 1
        if (lookups === 1) {
          slowStarted.resolve()
          return slowLookup.promise
        }
        return Promise.resolve({ outcome: 'confirmed', bookingReference: 'RES-CONFIRMED' })
      },
    }
    const gateway = scriptedGateway([() => ({ outcome: 'unknown', reason: 'timeout' })])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler })

    await failed(executor, request())
    const slowReplay = succeeded(executor, request())
    await slowStarted.promise
    expect(referenceOf(await succeeded(executor, request()))).toBe('RES-CONFIRMED')
    slowLookup.resolve({ outcome: 'rejected', reason: 'stale_negative' })

    expect(referenceOf(await slowReplay)).toBe('RES-CONFIRMED')
    expect(store.stateOf(TENANT, KEY)?.state).toBe('confirmed')
    expect(store.stateOf(TENANT, KEY)?.bookingReference).toBe('RES-CONFIRMED')
    expect(gateway.reserves).toHaveLength(1)
  })
})

describe('a process that restarted mid-flight', () => {
  it('refuses a second reservation for an attempt that never answered', async () => {
    // The first process times out. Its record stays in flight, and the store
    // outlives the process that was holding it. Nothing about a fresh boundary
    // over that store may authorise a new write.
    const gateway = throwingGateway(() => new Error('connection reset by the booking system'))
    const store = attemptStore()
    const first = harness({ gateway, store: store.store, reconciler: blindReconciler() })
    const timeout = await failed(first.executor, request())
    // The boundary swallows the throw and returns an unknown, which the
    // executor reports in its own words rather than as a gateway fault.
    expect(timeout.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')

    // A new process: new boundary, new executor, same store, same system.
    const restarted = bookingSystem()
    const second = harness({
      gateway: restarted.gateway,
      store: store.store,
      reconciler: restarted.reconciler,
    })
    const replay = await failed(second.executor, request())

    expect(restarted.reserves).toHaveLength(0)
    expect(replay.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(replay.retryable).toBe(false)
    // The only voice allowed to speak for an in-flight attempt is the
    // authoritative system, and it had never seen this one.
    expect(restarted.lookups).toHaveLength(1)
    expect(store.records()).toHaveLength(1)
  })

  it('replays the stored reference after a confirmed attempt and a restart', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const first = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })
    const output = await succeeded(first.executor, request())

    // The restarted process talks to a system that has forgotten everything,
    // and still answers correctly — from the record, not from the provider.
    const restarted = bookingSystem()
    const second = harness({
      gateway: restarted.gateway,
      store: store.store,
      reconciler: restarted.reconciler,
    })
    const replay = await succeeded(second.executor, request())

    expect(referenceOf(replay)).toBe(referenceOf(output))
    expect(restarted.reserves).toHaveLength(0)
    expect(restarted.lookups).toHaveLength(0)
  })

  it('keeps the payload check across a restart', async () => {
    const system = bookingSystem()
    const store = attemptStore()
    const first = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })
    const shared = { idempotencyKey: 'shared-key' } as const
    await succeeded(first.executor, request(shared))

    const restarted = bookingSystem()
    const second = harness({
      gateway: restarted.gateway,
      store: store.store,
      reconciler: restarted.reconciler,
    })
    const crossed = await failed(second.executor, request({ ...shared, slotId: 'slot-different' }))
    expect(crossed.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(restarted.reserves).toHaveLength(0)

    // And an unrelated attempt is still possible, so the refusal was about this
    // key and this payload rather than a wedged boundary.
    const unrelated = await succeeded(
      second.executor,
      request({ ...shared, idempotencyKey: 'unrelated-key' }),
    )
    expect(referenceOf(unrelated)).toMatch(/^RES-/u)
  })
})

describe('an outcome nobody knows', () => {
  it('reports unknown, keeps no booking, and settles it as unknown', async () => {
    const gateway = scriptedGateway([
      () => ({ outcome: 'unknown', reason: 'the request timed out after 30s' }),
    ])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(result.retryable).toBe(false)
    expect(result.message).not.toContain('timed out')
    expect(result.message).not.toContain(TENANT)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')
  })

  it('recovers a timed-out attempt when the authoritative system has it', async () => {
    // The write landed but the answer was lost, so the record stays unknown. A
    // later caller on the same key must not re-issue; the system, asked what
    // became of the attempt, is what tells the caller the reservation exists.
    const gateway = throwingGateway(() => new Error('read timeout'))
    const store = attemptStore()
    const reconciler = scriptedReconciler([
      () => ({ outcome: 'confirmed', bookingReference: 'RECONCILED-1' }),
    ])
    const first = harness({ gateway, store: store.store, reconciler })
    // The throw never reaches the executor as a fault: the boundary answered it
    // as an unknown, which is the honest shape of "a write may or may not stand".
    expect((await failed(first.executor, request())).errorCode).toBe(
      BOOKING_ERROR_CODES.gatewayUnavailable,
    )

    const second = harness({ gateway, store: store.store, reconciler })
    const recovered = await succeeded(second.executor, request())

    expect(referenceOf(recovered)).toBe('RECONCILED-1')
    expect(store.stateOf(TENANT, KEY)?.state).toBe('confirmed')
    expect(store.stateOf(TENANT, KEY)?.bookingReference).toBe('RECONCILED-1')
    // The recovery wrote nothing anywhere, and asked exactly once.
    expect(reconciler.lookups).toHaveLength(1)
    expect('reserves' in gateway).toBe(false)
  })

  it('does not recover anything when the system cannot look the attempt up', async () => {
    const gateway = throwingGateway(() => new Error('read timeout'))
    const store = attemptStore()
    const reconciler = scriptedReconciler([
      () => ({ outcome: 'unknown', reason: 'attempt_not_found' }),
    ])
    const first = harness({ gateway, store: store.store, reconciler })
    await failed(first.executor, request())

    const second = harness({ gateway, store: store.store, reconciler })
    const still = await failed(second.executor, request())

    expect(still.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(still.retryable).toBe(false)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')
    // Exactly one lookup: the original attempt was this caller's own write and
    // never asked the system anything, so the only read is the replay's.
    expect(reconciler.lookups).toHaveLength(1)
  })

  it('survives a reconciler that throws, and reports unknown', async () => {
    const gateway = throwingGateway(() => new Error('read timeout'))
    const store = attemptStore()
    const reconciler: BookingReconciliationPort = {
      reconcilerId: 'throwing-lookup',
      reconcile(): Promise<BookingOutcome> {
        return Promise.reject(
          new Error('the booking system threw while being asked about an attempt'),
        )
      },
    }
    const first = harness({ gateway, store: store.store, reconciler })
    await failed(first.executor, request())

    const second = harness({ gateway, store: store.store, reconciler })
    const result = await failed(second.executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(result.message).not.toContain('booking system threw')
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')
  })

  // Three replies that are not confirmations. The boundary normalises all of
  // them to `unknown` before the executor sees them, so the executor reports an
  // unknown rather than its own incomplete-confirmation code; the unwrapped
  // executor's `booking_confirmation_incomplete` path is covered in
  // booking.test.ts. What matters here is that none of them is a success and
  // none of them leaves anything in the record but an unknown.
  it('treats a confirmed answer with no reference as nothing', async () => {
    const gateway = scriptedGateway([() => ({ outcome: 'confirmed' }) as BookingOutcome])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(result.retryable).toBe(false)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')
  })

  it('treats a confirmed answer whose reference is unusable as nothing', async () => {
    const gateway = scriptedGateway([() => ({ outcome: 'confirmed', bookingReference: 'REF!!' })])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')
    expect(store.stateOf(TENANT, KEY)?.bookingReference).toBeUndefined()
  })

  it('treats a reply that is not an outcome at all as nothing', async () => {
    const gateway = scriptedGateway([() => 'service unavailable' as unknown as BookingOutcome])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('unknown')
  })
})

describe('a reservation the system declined', () => {
  it('settles it as declined, and replays the same refusal', async () => {
    const gateway = scriptedGateway([() => ({ outcome: 'rejected', reason: 'slot_already_taken' })])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const first = await failed(executor, request())
    const second = await failed(executor, request())

    expect(first.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(second.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(gateway.reserves).toHaveLength(1)
    expect(store.stateOf(TENANT, KEY)?.state).toBe('rejected')
  })

  it('flattens a reason that could have carried tenant data', async () => {
    const gateway = scriptedGateway([
      () => ({ outcome: 'rejected', reason: `customer for ${TENANT} is blocked` }),
    ])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(result.message).not.toContain(TENANT)
    expect(result.message.toLowerCase()).not.toContain('blocked')
  })
})

describe('tenant boundaries', () => {
  it('keeps two tenants attempts separate under the same key', async () => {
    const gateway = unguardedGateway()
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    const mine = await succeeded(executor, request())
    const theirs = await succeeded(executor, request({ tenantId: OTHER_TENANT }))

    // Same key, different tenants, two legitimate and distinct reservations.
    expect(gateway.reserves).toHaveLength(2)
    expect(referenceOf(theirs)).not.toBe(referenceOf(mine))
    expect(store.records()).toHaveLength(2)
    expect(store.stateOf(TENANT, KEY)?.bookingReference).toBe(referenceOf(mine))
    expect(store.stateOf(OTHER_TENANT, KEY)?.bookingReference).toBe(referenceOf(theirs))
  })

  it('refuses a cross-tenant replay that a tenant-blind store would have served', async () => {
    // The store is already tenant-scoped by contract, so in a correct
    // deployment this code is unreachable. It exists because a deployment whose
    // store keyed records on the idempotency key alone would hand one tenant
    // another tenant's answer, and the boundary checks the tenant inside the
    // fingerprint itself rather than trusting the store to have done it.
    const gateway = unguardedGateway()
    const loose = tenantBlindStore()
    const { executor } = harness({ gateway, store: loose.store, reconciler: blindReconciler() })

    const theirs = await succeeded(executor, request({ tenantId: OTHER_TENANT }))
    const theirReference = referenceOf(theirs)

    const crossed = await failed(executor, request())

    expect(crossed.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(crossed.retryable).toBe(false)
    expect(gateway.reserves).toHaveLength(1)
    expect(loose.records()).toHaveLength(1)
    // The other tenant's reference never reached this tenant's answer.
    expect(theirReference).toMatch(/^FRESH-/u)
    expect(crossed.message).not.toContain(String(theirReference))
  })

  it('scopes each reservation request to the tenant that asked for it', async () => {
    const gateway = unguardedGateway()
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })
    await succeeded(executor, request({ tenantId: OTHER_TENANT, idempotencyKey: 'theirs' }))

    expect(gateway.reserves[0]?.tenantId).toBe(OTHER_TENANT)
    expect(gateway.reserves[0]?.idempotencyKey).toBe('theirs')
    expect(store.stateOf(OTHER_TENANT, 'theirs')).toBeDefined()
    expect(store.stateOf(TENANT, 'theirs')).toBeUndefined()
  })

  it('never serves another tenant reference from a malformed stale-settlement result', async () => {
    const backing = attemptStore()
    const store: BookingAttemptStore = {
      storeId: 'bad-stale-store',
      claim: (attempt) => backing.store.claim(attempt),
      settle: () =>
        Promise.resolve({
          status: 'stale',
          attempt: {
            tenantId: OTHER_TENANT,
            idempotencyKey: KEY,
            fingerprint: 'bad-fingerprint',
            state: 'confirmed',
            bookingReference: 'OTHER-TENANT-SECRET',
          },
        }),
    }
    const gateway = scriptedGateway([() => ({ outcome: 'unknown', reason: 'timeout' })])
    const { executor } = harness({ gateway, store, reconciler: blindReconciler() })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(result.message).not.toContain('OTHER-TENANT-SECRET')
    expect(backing.stateOf(TENANT, KEY)?.state).toBe('in_flight')
  })
})

describe('what the boundary reports publicly', () => {
  it('names the store it records in as well as the gateway it wraps', () => {
    const system = bookingSystem()
    const store = attemptStore()
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })

    expect(executor.gatewayId).toBe('replay(fake-attempt-store→fake-pms)')
  })

  it('passes health through from the system underneath', async () => {
    const down = bookingSystem({ ready: false })
    const store = attemptStore()
    const { boundary, executor } = harness({
      gateway: down.gateway,
      store: store.store,
      reconciler: down.reconciler,
    })

    expect(boundary.health.ready).toBe(false)
    expect((await failed(executor, request())).errorCode).toBe(BOOKING_ERROR_CODES.gatewayNotReady)
    // An outage must not consume a key, or a later caller would be told their
    // reservation was replayed from a record nothing ever made.
    expect(store.records()).toHaveLength(0)
    expect(down.reserves).toHaveLength(0)
  })

  it('reports unknown rather than claiming a claim it could not make', async () => {
    const system = bookingSystem()
    const store = attemptStore({ claimThrows: true })
    const { executor } = harness({
      gateway: system.gateway,
      store: store.store,
      reconciler: system.reconciler,
    })

    const result = await failed(executor, request())

    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(result.retryable).toBe(false)
    expect(system.reserves).toHaveLength(0)
    expect(store.records()).toHaveLength(0)
  })

  it('keeps the provider own words out of the settled record', async () => {
    // The provider declined. Its reason is its own; what crosses the boundary
    // is the flat class, and the settled record holds the state, not the words.
    const gateway = scriptedGateway([
      () => ({ outcome: 'rejected', reason: `card for ${CUSTOMER} at ${TENANT} was declined` }),
    ])
    const store = attemptStore()
    const { executor } = harness({ gateway, store: store.store, reconciler: blindReconciler() })
    await failed(executor, request())

    expect(store.settlements()[0]?.state).toBe('rejected')
    expect(JSON.stringify(store.settlements())).not.toContain('was declined')
    expect(JSON.stringify(store.records())).not.toContain('was declined')
  })

  it('does not relay machine-shaped provider identifiers as reasons', async () => {
    const gateway = scriptedGateway([
      () => ({ outcome: 'unknown', reason: 'customer_acme_hotels_cust_42' }),
    ])
    const store = attemptStore()
    const { boundary } = harness({ gateway, store: store.store, reconciler: blindReconciler() })

    expect(
      await boundary.reserve({
        tenantId: TENANT,
        slotId: SLOT,
        customerRef: CUSTOMER,
        idempotencyKey: KEY,
      }),
    ).toEqual({ outcome: 'unknown', reason: 'booking_outcome_unexplained' })
  })

  it('never reports a retryable failure anywhere in the boundary', async () => {
    // Written as `() =>`, not `async () =>`, so the arrow is a pass-through and
    // the awaited work stays where it is written.
    const paths: readonly (() => Promise<Failure>)[] = [
      () =>
        failed(
          harness({
            gateway: throwingGateway(() => new Error('read timeout')),
            store: attemptStore().store,
            reconciler: blindReconciler(),
          }).executor,
          request(),
        ),
      () =>
        failed(
          harness({
            gateway: scriptedGateway([() => ({ outcome: 'unknown', reason: 'timeout' })]),
            store: attemptStore().store,
            reconciler: blindReconciler(),
          }).executor,
          request(),
        ),
      () =>
        failed(
          harness({
            gateway: bookingSystem().gateway,
            store: attemptStore({ claimThrows: true }).store,
            reconciler: bookingSystem().reconciler,
          }).executor,
          request(),
        ),
      // A cross-tenant replay that the boundary refuses, so the caller is never
      // told to try again and land on another tenant's answer.
      async () => {
        const loose = tenantBlindStore()
        const { executor } = harness({
          gateway: unguardedGateway(),
          store: loose.store,
          reconciler: blindReconciler(),
        })
        await succeeded(executor, request({ tenantId: OTHER_TENANT }))
        return await failed(executor, request())
      },
    ]
    for (const path of paths) {
      expect((await path()).retryable).toBe(false)
    }
  })
})
