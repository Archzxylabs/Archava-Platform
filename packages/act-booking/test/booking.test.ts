import { describe, expect, it } from 'vitest'
import type { ActionExecutionRequest } from '@archava/assistant'

import {
  BOOKING_ERROR_CODES,
  BookingActionExecutor,
  gatewayReady,
  isConfirmedBooking,
  type BookingGateway,
  type BookingOutcome,
  type BookingReservationRequest,
} from '../src/index.js'

/**
 * The booking.create executor, as a black box with a gateway wired to the front.
 *
 * The property this file exists to lock down is that **a booking is only ever
 * reported when a gateway confirmed one.** Every other outcome — declined,
 * unknown, thrown, confirmed-but-silent, unreachable, misaddressed, malformed —
 * has to come back as a failure with a machine-readable code, because the one
 * outcome that must never happen is a `succeeded` standing behind a turn where
 * nothing was reserved. A visitor told a booking exists that does not is worse
 * than a visitor told the booking could not be made.
 *
 * So every test sets up a gateway *answer* and asserts what the pipeline would
 * see. The fake below is deliberately not a booking system — it answers whatever
 * the test tells it to and records what it was asked. It proves this executor's
 * handling of an external outcome, and nothing at all about whether any real
 * system makes a reservation.
 *
 * Three facts about the contract a reader should know before trusting a pass:
 *
 * 1. The action ids in the dispatch table are written out rather than read from
 *    the module, for the same reason the validation suite does it: a test that
 *    enumerated the executor's own registry would pass on whatever the registry
 *    happened to contain.
 * 2. The confirmed-with-no-reference case is a *reply*, not a crash. A gateway
 *    answering `confirmed` with an empty reference is the single most dangerous
 *    line in this package, and gets its own tests.
 * 3. `retryable` is `false` on every failure, asserted per case. `booking.create`
 *    is idempotent, so a caller may replay the same key — but an *automatic*
 *    retry after a timeout is the double-booking path, and this executor must
 *    never hand a caller the excuse.
 */

const TENANT = 'acme-hotels'
const SESSION = 'sess-01'
const KEY = 'idem-key-1'

/** A gateway that answers whatever the test says, and records what it was asked. */
type FakeGateway = BookingGateway & {
  readonly reserves: readonly BookingReservationRequest[]
  outcome: BookingOutcome
  ready: boolean
  readyReason: string
  failure: unknown
  failMode: 'reject' | 'throw'
}

function fakeGateway(): FakeGateway {
  const reserves: BookingReservationRequest[] = []
  const fake: FakeGateway = {
    gatewayId: 'fake-booking-system',
    // The knobs and the gateway are the same object on purpose: `health.ready`
    // reads through to `ready`, so setting the knob is the only way it changed.
    ready: true,
    readyReason: 'the booking system is reachable',
    outcome: { outcome: 'confirmed', bookingReference: 'REF-4481' },
    failure: undefined,
    failMode: 'reject',
    health: {
      get ready(): boolean {
        return fake.ready
      },
      get reason(): string {
        return fake.readyReason
      },
    },
    reserve(request: BookingReservationRequest): Promise<BookingOutcome> {
      reserves.push(request)
      if (fake.failure !== undefined) {
        // The subject under test is a port that fails in the way real systems fail
        // — ECONNRESET, but also the string a half-written client pushed — so this
        // fake has to be able to fail with something that is not an Error.
        if (fake.failMode === 'throw') {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the subject under test
          throw fake.failure
        }
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the subject under test
        return Promise.reject(fake.failure)
      }
      return Promise.resolve(fake.outcome)
    },
    get reserves(): readonly BookingReservationRequest[] {
      return reserves
    },
  }
  return fake
}

/**
 * A gateway that keeps a ledger, the way `gateway.ts` requires one to.
 *
 * The fake above answers a single call, which is what a test about one outcome
 * needs, and it cannot answer a *replay*: a replay is a property of a system
 * that remembers. Against a gateway that kept no ledger, an executor that minted
 * a fresh key per call would look perfect.
 *
 * A conflicting payload under a seen key is refused rather than applied, and
 * that is the half of the contract which makes the other half safe. A key that
 * may be reused to write a *different* reservation is worse than no key at all,
 * because it turns a retry into the second booking nobody asked for.
 */
function dedupGateway(): BookingGateway & {
  readonly attempts: readonly BookingReservationRequest[]
  readonly reservations: readonly BookingReservationRequest[]
} {
  const ledger = new Map<string, readonly [BookingReservationRequest, string]>()
  const attempts: BookingReservationRequest[] = []
  const reservations: BookingReservationRequest[] = []
  return {
    gatewayId: 'dedup-booking-system',
    health: { ready: true, reason: 'the booking system is reachable' },
    reserve(request: BookingReservationRequest): Promise<BookingOutcome> {
      attempts.push(request)
      const ledgerKey = JSON.stringify([request.tenantId, request.idempotencyKey])
      const seen = ledger.get(ledgerKey)
      if (seen === undefined) {
        const reference = `REF-${String(ledger.size + 1).padStart(4, '0')}`
        reservations.push(request)
        ledger.set(ledgerKey, [request, reference])
        return Promise.resolve({ outcome: 'confirmed', bookingReference: reference })
      }
      const [first, reference] = seen
      return Promise.resolve(
        sameAttempt(first, request)
          ? { outcome: 'confirmed', bookingReference: reference }
          : { outcome: 'rejected', reason: 'idempotency_key_conflict' },
      )
    },
    get attempts(): readonly BookingReservationRequest[] {
      return attempts
    },
    get reservations(): readonly BookingReservationRequest[] {
      return reservations
    },
  }
}

/** Whether a replay is the same attempt, judged on everything but the key. */
function sameAttempt(a: BookingReservationRequest, b: BookingReservationRequest): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.slotId === b.slotId &&
    a.customerRef === b.customerRef &&
    a.notes === b.notes
  )
}

/**
 * A gateway that answers per tenant, the way a real one scopes by tenant.
 *
 * One tenant has the slot and the other does not. The fixture exists for the
 * thing the executor must *not* do: nothing in it may remember that one tenant
 * was answered `REF-0001` and hand that reference to the next. An executor that
 * memoised on the slot would pass every single-call test in this file and leak a
 * reservation across a tenant boundary here.
 */
function scopedGateway(): BookingGateway & {
  readonly writes: readonly BookingReservationRequest[]
} {
  const answers = new Map<string, BookingOutcome>([
    [TENANT, { outcome: 'confirmed', bookingReference: 'REF-0001' }],
  ])
  const writes: BookingReservationRequest[] = []
  return {
    gatewayId: 'scoped-booking-system',
    health: { ready: true, reason: 'the booking system is reachable' },
    reserve(request: BookingReservationRequest): Promise<BookingOutcome> {
      writes.push(request)
      return Promise.resolve(
        answers.get(request.tenantId) ?? { outcome: 'rejected', reason: 'slot_not_found' },
      )
    },
    get writes(): readonly BookingReservationRequest[] {
      return writes
    },
  }
}

/** A validated `booking.create` request, as §9 would have handed it on. */
function request(overrides?: {
  action?: string
  slotId?: unknown
  customer?: unknown
  notes?: unknown
  tenantId?: string
  idempotencyKey?: string
  extra?: Readonly<Record<string, unknown>>
}): ActionExecutionRequest {
  const slotId = overrides?.slotId === undefined ? 'slot-9' : overrides.slotId
  const customer =
    overrides?.customer === undefined
      ? {
          customerRef: 'cust-42',
          ...(overrides?.notes === undefined ? {} : { notes: overrides.notes }),
        }
      : overrides.customer
  return {
    tenantId: overrides?.tenantId === undefined ? TENANT : overrides.tenantId,
    sessionId: SESSION,
    action: overrides?.action === undefined ? 'booking.create' : overrides.action,
    inputs: { slotId, customer, ...overrides?.extra },
    idempotencyKey: overrides?.idempotencyKey === undefined ? KEY : overrides.idempotencyKey,
  }
}

/** Run the executor, and insist the result was a failure. */
async function failure(
  gateway: BookingGateway,
  req: ActionExecutionRequest,
): Promise<{ status: 'failed'; errorCode: string; retryable: boolean; message: string }> {
  const result = await new BookingActionExecutor({ gateway }).execute(req)
  if (result.status !== 'failed') {
    throw new Error(
      `expected a failure, and got ${result.status} with output ${JSON.stringify(result.output)}`,
    )
  }
  return result
}

/** Run the executor, and insist the result succeeded. */
async function succeeded(
  gateway: BookingGateway,
  req: ActionExecutionRequest,
): Promise<Readonly<Record<string, unknown>>> {
  const result = await new BookingActionExecutor({ gateway }).execute(req)
  if (result.status !== 'succeeded') {
    throw new Error(`expected a success, and got ${result.status}: ${result.errorCode}`)
  }
  return result.output
}

describe('booking.create dispatch', () => {
  const NEIGHBOURS: readonly string[] = [
    'booking.reschedule',
    'booking.cancel',
    'availability.read',
    'email.send',
    'admin.config.update',
    'booking.create.v2',
    '',
  ]

  it.each(NEIGHBOURS)('refuses %s, and sends nothing', async (action) => {
    const gateway = fakeGateway()
    const result = await failure(gateway, request({ action }))
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.unsupportedAction)
    expect(gateway.reserves, `${action} must not reach the gateway`).toHaveLength(0)
  })

  it('does not echo an untrusted action id in a public failure', async () => {
    const message = (await failure(fakeGateway(), request({ action: 'booking.reschedule' })))
      .message
    expect(message).not.toContain('booking.reschedule')
  })

  it('refuses a misaddressed action even when its inputs are perfectly valid', async () => {
    // The trap this closes: an executor that validated inputs *first* would have
    // found `slot-9` / `cust-42` fine, then hit the dispatch check — which reads
    // like it ran, and did nothing useful.
    const gateway = fakeGateway()
    const result = await failure(gateway, request({ action: 'email.send' }))
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.unsupportedAction)
    expect(gateway.reserves).toHaveLength(0)
  })

  it('every refusal is retryable: false', async () => {
    const result = await failure(fakeGateway(), request({ action: 'booking.cancel' }))
    expect(result.retryable).toBe(false)
  })
})

describe('the fields that reach the gateway', () => {
  it('hands over exactly the contract fields, and the idempotency key', async () => {
    const gateway = fakeGateway()
    await succeeded(gateway, request({ notes: 'window table' }))
    expect(gateway.reserves).toEqual([
      {
        tenantId: TENANT,
        slotId: 'slot-9',
        customerRef: 'cust-42',
        notes: 'window table',
        idempotencyKey: KEY,
      },
    ])
  })

  it('omits notes entirely when the caller supplied none', async () => {
    const gateway = fakeGateway()
    await succeeded(gateway, request())
    const [sent] = gateway.reserves
    expect(sent).toBeDefined()
    expect('notes' in (sent ?? {})).toBe(false)
  })

  it('lets no field the contract never named reach a reservation', async () => {
    // A price, a date, a status, a reference: values a model was free to supply
    // and nobody validated. If one lands in the gateway call, then something
    // unvalidated decided a reservation.
    const gateway = fakeGateway()
    await succeeded(
      gateway,
      request({
        extra: {
          price: '49.00',
          date: '2026-10-01',
          status: 'confirmed',
          bookingReference: 'REF-I-MADE-THIS-UP',
          tenantId: 'somebody-else',
        },
      }),
    )
    const [sent] = gateway.reserves
    expect(sent).toBeDefined()
    expect(Object.keys(sent ?? {}).sort()).toEqual(
      ['customerRef', 'idempotencyKey', 'slotId', 'tenantId'].sort(),
    )
    expect(sent).not.toHaveProperty('price')
    expect(sent).not.toHaveProperty('status')
    expect(sent).not.toHaveProperty('bookingReference')
  })

  it('refuses a blank tenant, and sends nothing', async () => {
    const gateway = fakeGateway()
    const result = await failure(gateway, request({ tenantId: '   ' }))
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.malformedInput)
    expect(gateway.reserves).toHaveLength(0)
  })

  const MALFORMED: ReadonlyArray<Readonly<{ label: string; over: Parameters<typeof request>[0] }>> =
    [
      { label: 'a slotId that is not a string', over: { slotId: 9 } },
      { label: 'a blank slotId', over: { slotId: '  ' } },
      { label: 'a customer that is not an object', over: { customer: 'cust-42' } },
      { label: 'a customer with no reference', over: { customer: {} } },
      { label: 'a reference that is not a string', over: { customer: { customerRef: 42 } } },
      { label: 'a blank reference', over: { customer: { customerRef: ' ' } } },
      { label: 'notes that are not a string', over: { notes: 7 } },
      { label: 'blank notes', over: { notes: ' ' } },
      { label: 'a null customer', over: { customer: null } },
    ]

  it.each(MALFORMED)('refuses $label rather than guessing the field', async ({ over }) => {
    const gateway = fakeGateway()
    const result = await failure(gateway, request(over))
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.malformedInput)
    expect(gateway.reserves, 'a malformed request must not reach the gateway').toHaveLength(0)
    expect(result.retryable).toBe(false)
  })

  it('refuses a request that carries no slotId at all', async () => {
    const gateway = fakeGateway()
    const noSlot: ActionExecutionRequest = {
      ...request(),
      inputs: { customer: { customerRef: 'cust-42' } },
    }
    expect((await failure(gateway, noSlot)).errorCode).toBe(BOOKING_ERROR_CODES.malformedInput)
    expect(gateway.reserves).toHaveLength(0)
  })

  it('refuses a malformed direct-call inputs object', async () => {
    const gateway = fakeGateway()
    const malformed = { ...request(), inputs: null as unknown as Record<string, unknown> }
    expect((await failure(gateway, malformed)).errorCode).toBe(BOOKING_ERROR_CODES.malformedInput)
    expect(gateway.reserves).toHaveLength(0)
  })

  it('never echoes the field it could not read back to the caller', async () => {
    // A refusal message that repeated the inputs would be putting tenant data on
    // a surface a visitor can read.
    const result = await failure(fakeGateway(), {
      ...request(),
      inputs: { customer: { customerRef: 'cust-42' } },
    })
    expect(result.message).not.toContain('cust-42')
    expect(result.message).not.toContain(TENANT)
    expect(result.message).not.toContain(SESSION)
  })
})

describe('a confirmed reservation', () => {
  it('reports succeeded with the reference the gateway issued', async () => {
    const output = await succeeded(fakeGateway(), request())
    expect(output['bookingReference']).toBe('REF-4481')
    expect(output['status']).toBe('confirmed')
  })

  it('carries the gateway reference through, not one minted here', async () => {
    // Two gateways, two references: a reference invented inside the executor would
    // be the same string whatever answered.
    const first = fakeGateway()
    first.outcome = { outcome: 'confirmed', bookingReference: 'REF-1' }
    const second = fakeGateway()
    second.outcome = { outcome: 'confirmed', bookingReference: 'REF-2' }
    expect((await succeeded(first, request()))['bookingReference']).toBe('REF-1')
    expect((await succeeded(second, request()))['bookingReference']).toBe('REF-2')
  })

  it('reports nothing at all when the gateway confirmed without a reference', async () => {
    // The dangerous reply: `confirmed`, and nothing behind it. Without this test a
    // visitor is told a booking exists for a reservation nobody made.
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'confirmed', bookingReference: '' }
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.incompleteConfirmation)
    expect(result.retryable).toBe(false)
  })

  it('treats a whitespace reference as no reference', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'confirmed', bookingReference: '   ' }
    expect((await failure(gateway, request())).errorCode).toBe(
      BOOKING_ERROR_CODES.incompleteConfirmation,
    )
  })

  it('refuses a reference containing customer contact data', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'confirmed', bookingReference: 'guest@example.com' }
    expect((await failure(gateway, request())).errorCode).toBe(
      BOOKING_ERROR_CODES.incompleteConfirmation,
    )
  })

  it('refuses a confirmation that only looks complete', async () => {
    // Fields a plausible-looking reply might also carry. The reference is the
    // thing that makes it a booking, and an empty one is not a booking.
    const gateway = fakeGateway()
    gateway.outcome = {
      outcome: 'confirmed',
      bookingReference: '',
      status: 'confirmed',
      slotId: 'slot-9',
    } as unknown as BookingOutcome
    await expect(failure(gateway, request())).resolves.toMatchObject({
      errorCode: BOOKING_ERROR_CODES.incompleteConfirmation,
    })
  })

  it('the narrowing guard agrees with what the executor reports', () => {
    expect(isConfirmedBooking({ outcome: 'confirmed', bookingReference: 'REF-1' })).toBe(true)
    expect(isConfirmedBooking({ outcome: 'confirmed', bookingReference: '' })).toBe(false)
    expect(isConfirmedBooking({ outcome: 'confirmed', bookingReference: '  ' })).toBe(false)
    expect(isConfirmedBooking({ outcome: 'rejected', reason: 'slot_taken' })).toBe(false)
    expect(isConfirmedBooking({ outcome: 'unknown', reason: 'timed out' })).toBe(false)
    expect(isConfirmedBooking({ outcome: 'confirmed' })).toBe(false)
    expect(isConfirmedBooking(null)).toBe(false)
  })

  it('fails closed on malformed gateway JSON', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'confirmed' } as BookingOutcome
    expect((await failure(gateway, request())).errorCode).toBe(
      BOOKING_ERROR_CODES.incompleteConfirmation,
    )
    gateway.outcome = null as unknown as BookingOutcome
    expect((await failure(gateway, request())).errorCode).toBe(
      BOOKING_ERROR_CODES.incompleteConfirmation,
    )
  })
})

describe('a declined reservation', () => {
  it('fails without carrying the gateway reason into public output', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'rejected', reason: 'slot_taken' }
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(result.retryable).toBe(false)
  })

  it('drops even a machine-shaped reason', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'rejected', reason: '  SlotTaken  ' }
    expect((await failure(gateway, request())).errorCode).toBe(BOOKING_ERROR_CODES.declined)
  })

  it('drops a reason written as prose, and still reports the decline', async () => {
    // The gate that closed the leak: a reason naming the tenant would otherwise be
    // slugged into an error code that lands in logs and metrics.
    const gateway = fakeGateway()
    gateway.outcome = {
      outcome: 'rejected',
      reason: `slot taken for tenant ${TENANT}, ask ops before retrying`,
    }
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(result.errorCode).not.toContain(TENANT)
  })

  it('drops a reason that is not shaped like an identifier at all', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'rejected', reason: '!!!' }
    expect((await failure(gateway, request())).errorCode).toBe(BOOKING_ERROR_CODES.declined)
  })

  it('drops an over-long machine reason rather than truncating it into something unsafe', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'rejected', reason: `reason_${'x'.repeat(60)}` }
    expect((await failure(gateway, request())).errorCode).toBe(BOOKING_ERROR_CODES.declined)
  })
})

describe('an outcome nobody knows', () => {
  it('fails with the unknown code, and reports no booking', async () => {
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'unknown', reason: 'the request timed out after 30s' }
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayUnavailable)
    expect(result.retryable).toBe(false)
    expect('output' in result).toBe(false)
  })

  it('never turns a timeout into a booking', async () => {
    // `unknown` and `rejected` are different facts, and this is what keeps them
    // from being merged: a timeout says nothing about whether the write landed,
    // so the executor must report neither outcome.
    const reasons: readonly string[] = ['timeout', '', `connection reset for ${TENANT}`]
    for (const reason of reasons) {
      const gateway = fakeGateway()
      gateway.outcome = { outcome: 'unknown', reason }
      await expect(failure(gateway, request())).resolves.toMatchObject({
        errorCode: BOOKING_ERROR_CODES.gatewayUnavailable,
      })
    }
  })

  it('an unknown is retryable: false, so no caller retries it blind', async () => {
    // The whole reason the code exists. `booking.create` is idempotent, so a caller
    // *may* replay the same key — but an automatic retry on an unknown outcome is
    // the double-booking path.
    const gateway = fakeGateway()
    gateway.outcome = { outcome: 'unknown', reason: 'no reply' }
    expect((await failure(gateway, request())).retryable).toBe(false)
  })
})

describe('a gateway that fails', () => {
  it('turns a rejected promise into a classified failure', async () => {
    const gateway = fakeGateway()
    gateway.failure = new Error('ECONNRESET')
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayFailed)
    expect(result.retryable).toBe(false)
  })

  it('catches a synchronous throw too, rather than taking the turn down', async () => {
    const gateway = fakeGateway()
    gateway.failure = new TypeError('reserve is not a function')
    gateway.failMode = 'throw'
    expect((await failure(gateway, request())).errorCode).toBe(BOOKING_ERROR_CODES.gatewayFailed)
  })

  it('does not let the gateway words reach the result, because they may name a tenant', async () => {
    // An exception message is the one place a booking system is likely to have put
    // an internal identifier. The class crosses this boundary; the sentence does not.
    const gateway = fakeGateway()
    gateway.failure = new Error(
      `write failed for tenant ${TENANT} on slot slot-9 for customer cust-42`,
    )
    const result = await failure(gateway, request())
    expect(result.message).not.toContain(TENANT)
    expect(result.message).not.toContain('cust-42')
    expect(result.message).not.toContain('slot-9')
  })

  it('does not carry a stack, and does not carry a non-Error rejection either', async () => {
    const gateway = fakeGateway()
    gateway.failure = 'the booking system went away'
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayFailed)
    expect(result.message).not.toContain('at ')
    expect(result.message).not.toContain('went away')
  })

  it('a gateway failure is classified apart from an unknown outcome', async () => {
    // Both mean "no booking", but a caller can page on one of them and not the
    // other, and structurally neither can be mistaken for a booking.
    const failed = fakeGateway()
    failed.failure = new Error('boom')
    const unknown = fakeGateway()
    unknown.outcome = { outcome: 'unknown', reason: 'no reply' }
    expect((await failure(failed, request())).errorCode).not.toBe(
      (await failure(unknown, request())).errorCode,
    )
  })
})

describe('an unreachable gateway', () => {
  it('declines before asking, and sends nothing', async () => {
    const gateway = fakeGateway()
    gateway.ready = false
    gateway.readyReason = 'the booking system is in maintenance'
    const result = await failure(gateway, request())
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.gatewayNotReady)
    expect(gateway.reserves).toHaveLength(0)
    expect(result.retryable).toBe(false)
  })

  it('does not surface the gateway readiness reason', async () => {
    const gateway = fakeGateway()
    gateway.ready = false
    gateway.readyReason = `tenant ${TENANT} is in maintenance`
    const result = await failure(gateway, request())
    expect(result.message).toBe('The booking system is unavailable.')
    expect(result.message).not.toContain(TENANT)
  })
})

describe('tenant scoping', () => {
  it('cannot reuse one tenant reservation for another', async () => {
    const gateway = scopedGateway()
    const one = await succeeded(gateway, request({ tenantId: TENANT }))
    const other = await failure(gateway, request({ tenantId: 'other-hotel' }))
    expect(one['bookingReference']).toBe('REF-0001')
    expect(other.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(gateway.writes.map((write) => write.tenantId)).toEqual([TENANT, 'other-hotel'])
  })
  it('sends the request tenant, not one it chose itself', async () => {
    const gateway = fakeGateway()
    await succeeded(gateway, request({ tenantId: 'other-hotel' }))
    expect(gateway.reserves[0]?.tenantId).toBe('other-hotel')
  })

  it('keeps the tenant id out of every failure message it can produce', async () => {
    const gateways: readonly FakeGateway[] = [
      Object.assign(fakeGateway(), { ready: false }),
      Object.assign(fakeGateway(), { outcome: { outcome: 'rejected', reason: 'slot_taken' } }),
      Object.assign(fakeGateway(), { outcome: { outcome: 'unknown', reason: 'timeout' } }),
      Object.assign(fakeGateway(), { outcome: { outcome: 'confirmed', bookingReference: '' } }),
      Object.assign(fakeGateway(), { failure: new Error(`tenant ${TENANT}`) }),
    ]
    for (const gateway of gateways) {
      const result = await failure(gateway, request())
      expect(result.message, result.errorCode).not.toContain(TENANT)
      expect(result.message, result.errorCode).not.toContain(SESSION)
      expect(result.errorCode, result.errorCode).not.toContain(TENANT)
    }
  })
})

describe('idempotency', () => {
  it('requires a nonblank key', async () => {
    const gateway = fakeGateway()
    expect((await failure(gateway, request({ idempotencyKey: ' ' }))).errorCode).toBe(
      BOOKING_ERROR_CODES.malformedInput,
    )
    expect(gateway.reserves).toHaveLength(0)
  })

  it('scopes replay keys by tenant', async () => {
    const gateway = dedupGateway()
    const one = await succeeded(gateway, request({ tenantId: TENANT }))
    const two = await succeeded(gateway, request({ tenantId: 'other-hotel' }))
    expect(one['bookingReference']).not.toBe(two['bookingReference'])
    expect(gateway.reservations).toHaveLength(2)
  })
  it('forwards the key the pipeline derived, unchanged', async () => {
    const gateway = fakeGateway()
    await succeeded(gateway, request({ idempotencyKey: 'key-from-pipeline' }))
    expect(gateway.reserves[0]?.idempotencyKey).toBe('key-from-pipeline')
  })

  it('a replay of the same key is recognisable as one attempt by the gateway', async () => {
    // The executor's half of the contract: it does not mint a fresh key per call,
    // so a gateway that deduplicates on the key can do its job.
    const gateway = fakeGateway()
    const executor = new BookingActionExecutor({ gateway })
    await executor.execute(request())
    await executor.execute(request())
    expect(gateway.reserves).toHaveLength(2)
    expect(gateway.reserves[0]?.idempotencyKey).toBe(gateway.reserves[1]?.idempotencyKey)
  })

  it('a replayed attempt is answered with the same reservation, and only one write', async () => {
    const gateway = dedupGateway()
    // A fresh executor per call on purpose. The gateway is the only thing that
    // can recognise a replay, so anything the executor remembered for itself
    // would be a second source of truth about what was reserved.
    const first = await succeeded(gateway, request())
    const second = await succeeded(gateway, request())
    expect(first).toEqual(second)
    expect(first['bookingReference']).toBe('REF-0001')
    expect(gateway.attempts).toHaveLength(2)
    expect(gateway.reservations).toHaveLength(1)
  })

  it('refuses a conflicting payload under the same key, and the first reservation stands', async () => {
    const gateway = dedupGateway()
    await succeeded(gateway, request())
    const result = await failure(gateway, request({ slotId: 'slot-10' }))
    expect(result.errorCode).toBe(BOOKING_ERROR_CODES.declined)
    expect(result.retryable).toBe(false)
    // The reservation that exists is the one the first attempt made, never the
    // retry's — a key reused to write a different slot is the double-booking.
    expect(gateway.reservations).toHaveLength(1)
    expect(gateway.reservations[0]?.slotId).toBe('slot-9')
  })

  it('a different slot is a different attempt, and earns its own reference', async () => {
    const gateway = dedupGateway()
    await succeeded(gateway, request())
    const second = await succeeded(gateway, request({ idempotencyKey: 'key-2' }))
    expect(second['bookingReference']).toBe('REF-0002')
    expect(gateway.reservations).toHaveLength(2)
  })
})

describe('the executor identity', () => {
  it('names itself and its gateway, for a trace', () => {
    const gateway = fakeGateway()
    const executor = new BookingActionExecutor({ gateway })
    expect(executor.executorId).toBe('booking.create@1')
    expect(executor.gatewayId).toBe('fake-booking-system')
  })

  it('reports a readiness it agrees with the gateway about', () => {
    const gateway = fakeGateway()
    expect(gatewayReady(gateway)).toBe(true)
    gateway.ready = false
    expect(gatewayReady(gateway)).toBe(false)
  })
})
