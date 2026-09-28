/**
 * What the composition seam promises, and what it refuses.
 *
 * The cases below are deliberately about the *seam*: that an incomplete
 * configuration refuses instead of half-honouring, that an executor built by
 * this factory cannot be aimed at another tenant, and that the executors behind
 * it still tell the truth about a side effect. The pipeline refusal cases
 * (capability, confirmation, validation, resolver) are in `workflow.test.ts`,
 * through the real `runTurn`.
 */

import { describe, expect, it } from 'vitest'
import type { ActionExecutionRequest } from '@archava/assistant'
import {
  ACT_COMPOSITION_FAULTS,
  ActCompositionRefusal,
  composeTenantActExecutor,
  type TenantActConfiguration,
} from '../src/index.js'
import {
  fakeBookingGateway,
  fakeBookingStore,
  fakeEmailGateway,
  fakeEmailStore,
  fakeReconciler,
  fakeStatusPort,
  fakeTemplateResolver,
  FINGERPRINT_KEY,
  OTHER_TENANT,
  TENANT,
  TEMPLATE_ID,
} from './fakes.js'

/** Everything a complete configuration needs, built once. */
function parts() {
  return {
    booking: {
      gateway: fakeBookingGateway({ outcome: 'confirmed', bookingReference: 'BOOK-1' }),
      store: fakeBookingStore(),
      reconciler: fakeReconciler({ outcome: 'rejected', reason: 'attempt_not_found' }),
    },
    email: {
      gateway: fakeEmailGateway({ outcome: 'accepted', providerMessageId: 'MSG-1' }),
      store: fakeEmailStore(),
      status: fakeStatusPort({ outcome: 'rejected', reason: 'status_not_available' }),
      templates: fakeTemplateResolver(),
    },
  }
}

/** A configuration whose seams can be replaced one at a time. */
function configuration(overrides: Partial<TenantActConfiguration> = {}): TenantActConfiguration {
  const built = parts()
  return {
    tenantId: TENANT,
    booking: {
      gateway: built.booking.gateway.gateway,
      store: built.booking.store.store,
      reconciler: built.booking.reconciler,
    },
    email: {
      gateway: built.email.gateway.gateway,
      store: built.email.store.store,
      status: built.email.status,
      templates: built.email.templates.resolver,
    },
    fingerprintKeys: { booking: FINGERPRINT_KEY, email: FINGERPRINT_KEY },
    ...overrides,
  }
}

/** Composed, together with the fakes its calls were recorded into. */
function composed(overrides: Partial<TenantActConfiguration> = {}) {
  const built = parts()
  const executor = composeTenantActExecutor({
    tenantId: TENANT,
    booking: {
      gateway: built.booking.gateway.gateway,
      store: built.booking.store.store,
      reconciler: built.booking.reconciler,
    },
    email: {
      gateway: built.email.gateway.gateway,
      store: built.email.store.store,
      status: built.email.status,
      templates: built.email.templates.resolver,
    },
    fingerprintKeys: { booking: FINGERPRINT_KEY, email: FINGERPRINT_KEY },
    ...overrides,
  })
  return {
    executor,
    booking: built.booking.gateway.calls,
    bookingClaims: built.booking.store.claims,
    bookingRecords: built.booking.store.records,
    email: built.email.gateway.calls,
    emailRecords: built.email.store.records,
    templateCalls: built.email.templates.calls,
  }
}

function bookingRequest(overrides: Partial<ActionExecutionRequest> = {}): ActionExecutionRequest {
  return {
    tenantId: TENANT,
    sessionId: 'session-1',
    action: 'booking.create',
    inputs: { slotId: 'slot-1', customer: { customerRef: 'cust-1' } },
    idempotencyKey: 'turn-1',
    ...overrides,
  }
}

function emailRequest(overrides: Partial<ActionExecutionRequest> = {}): ActionExecutionRequest {
  return {
    tenantId: TENANT,
    sessionId: 'session-1',
    action: 'email.send',
    inputs: { templateId: TEMPLATE_ID, to: 'guest@example.com' },
    idempotencyKey: 'turn-2',
    ...overrides,
  }
}

/** Read a refusal's reason without losing the failure if it was not thrown. */
function refusalReason(build: () => unknown): string {
  try {
    build()
  } catch (error) {
    expect(error, 'expected an ActCompositionRefusal').toBeInstanceOf(ActCompositionRefusal)
    return (error as ActCompositionRefusal).reason
  }
  return expect.unreachable('expected the configuration to be refused')
}

describe('composeTenantActExecutor', () => {
  it('wires both executors through the replay and outbox wrappers', () => {
    const subject = composed()
    // The identities are the wrappers', not the raw fakes': proof the
    // boundaries were constructed and are what the executor actually holds.
    expect(subject.executor.seam.booking).toContain('replay(')
    expect(subject.executor.seam.email).toContain('outbox(')
    expect(subject.executor.executorId).toContain(TENANT)
  })

  it('refuses a configuration that omits the tenant', () => {
    expect(refusalReason(() => composeTenantActExecutor(configuration({ tenantId: '' })))).toBe(
      ACT_COMPOSITION_FAULTS.tenantMissing,
    )
  })

  it('refuses a fingerprint key that is not server-only bytes of at least 32', () => {
    for (const bad of ['0'.repeat(32), new Uint8Array(16), 32]) {
      const reason = refusalReason(() =>
        composeTenantActExecutor(
          configuration({ fingerprintKeys: { booking: bad as never, email: bad as never } }),
        ),
      )
      expect([ACT_COMPOSITION_FAULTS.keyNotBytes, ACT_COMPOSITION_FAULTS.keyTooShort]).toContain(
        reason,
      )
    }
  })

  it('refuses each missing or malformed port with a reason naming that seam', () => {
    const base = configuration()
    const cases: ReadonlyArray<readonly [string, string, TenantActConfiguration]> = [
      [
        'booking gateway identity',
        ACT_COMPOSITION_FAULTS.bookingGatewayIdMissing,
        { ...base, booking: { ...base.booking, gateway: { reserve: () => undefined } as never } },
      ],
      [
        'booking gateway call',
        ACT_COMPOSITION_FAULTS.bookingGatewayNotCallable,
        {
          ...base,
          booking: {
            ...base.booking,
            gateway: {
              gatewayId: 'no-reserve',
              health: { ready: true, reason: 'ready' },
            } as never,
          },
        },
      ],
      [
        'booking gateway health',
        ACT_COMPOSITION_FAULTS.bookingGatewayHealthUnusable,
        {
          ...base,
          booking: {
            ...base.booking,
            gateway: { gatewayId: 'no-health', reserve: () => undefined } as never,
          },
        },
      ],
      [
        'booking store methods',
        ACT_COMPOSITION_FAULTS.bookingStoreNotUsable,
        { ...base, booking: { ...base.booking, store: { storeId: 'no-claim' } as never } },
      ],
      [
        'booking reconciler methods',
        ACT_COMPOSITION_FAULTS.reconcilerNotCallable,
        {
          ...base,
          booking: { ...base.booking, reconciler: { reconcilerId: 'no-reconcile' } as never },
        },
      ],
      [
        'email gateway call',
        ACT_COMPOSITION_FAULTS.emailGatewayNotCallable,
        { ...base, email: { ...base.email, gateway: {} as never } },
      ],
      [
        'email store methods',
        ACT_COMPOSITION_FAULTS.emailStoreNotUsable,
        { ...base, email: { ...base.email, store: { storeId: 'no-settle' } as never } },
      ],
      [
        'email status port identity',
        ACT_COMPOSITION_FAULTS.statusPortIdMissing,
        { ...base, email: { ...base.email, status: { status: () => undefined } as never } },
      ],
      [
        'email template resolver call',
        ACT_COMPOSITION_FAULTS.templateResolverNotCallable,
        { ...base, email: { ...base.email, templates: {} as never } },
      ],
    ]
    for (const [label, expected, config] of cases) {
      expect(
        refusalReason(() => composeTenantActExecutor(config)),
        label,
      ).toBe(expected)
    }
  })

  it('rejects malformed or throwing booking health at composition, while accepting unready health', () => {
    const base = configuration()
    for (const health of [{ ready: 'yes', reason: 'ready' }, { ready: true }, null]) {
      expect(
        refusalReason(() =>
          composeTenantActExecutor({
            ...base,
            booking: {
              ...base.booking,
              gateway: { ...base.booking.gateway, health } as never,
            },
          }),
        ),
      ).toBe(ACT_COMPOSITION_FAULTS.bookingGatewayHealthUnusable)
    }

    const throwingGateway = {
      gatewayId: 'throws-on-health',
      reserve: () => Promise.resolve({ outcome: 'unknown' as const, reason: 'unreachable' }),
      get health(): never {
        throw new Error('provider details must not escape')
      },
    }
    expect(
      refusalReason(() =>
        composeTenantActExecutor({
          ...base,
          booking: { ...base.booking, gateway: throwingGateway },
        }),
      ),
    ).toBe(ACT_COMPOSITION_FAULTS.bookingGatewayHealthUnusable)

    const unready = composeTenantActExecutor({
      ...base,
      booking: {
        ...base.booking,
        gateway: {
          gatewayId: 'unready',
          health: { ready: false, reason: 'maintenance' },
          reserve: () => Promise.resolve({ outcome: 'unknown' as const, reason: 'unreachable' }),
        },
      },
    })
    expect(unready.tenantId).toBe(TENANT)
  })

  it('keeps the tenant, the port identity and the provider out of a refusal', () => {
    const base = configuration()
    try {
      composeTenantActExecutor({ ...base, booking: { ...base.booking, store: undefined as never } })
      expect.unreachable('expected a refusal')
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain(TENANT)
      expect(message).not.toContain('pilot')
      expect(message).not.toContain('node_modules')
    }
  })
})

describe('the tenant binding', () => {
  it('reports its own tenant and nothing else', () => {
    const subject = composed()
    expect(subject.executor.tenantId).toBe(TENANT)
    expect(subject.executor.handles('booking.create', TENANT)).toBe(true)
    expect(subject.executor.handles('email.send', TENANT)).toBe(true)
    expect(subject.executor.handles('booking.create', OTHER_TENANT)).toBe(false)
    expect(subject.executor.handles('email.send', OTHER_TENANT)).toBe(false)
    expect(subject.executor.handles('knowledge.search', TENANT)).toBe(false)
  })

  it('refuses a request addressed to another tenant without calling any port', async () => {
    const subject = composed()
    const result = await subject.executor.execute(bookingRequest({ tenantId: OTHER_TENANT }))
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'act_executor_tenant_mismatch',
      retryable: false,
    })
    expect(subject.booking).toHaveLength(0)
    expect(subject.bookingClaims).toHaveLength(0)
  })

  it('refuses an action it does not dispatch, also without a port call', async () => {
    const subject = composed()
    const result = await subject.executor.execute(bookingRequest({ action: 'knowledge.search' }))
    expect(result).toMatchObject({ status: 'failed', errorCode: 'act_action_not_dispatched' })
    expect(subject.booking).toHaveLength(0)
    expect(subject.email).toHaveLength(0)
  })

  it('carries its tenant onto every port call, for both actions', async () => {
    const subject = composed()
    await subject.executor.execute(bookingRequest())
    await subject.executor.execute(emailRequest())
    expect(subject.booking.map((call) => call.tenantId)).toEqual([TENANT])
    expect(subject.email.map((call) => call.tenantId)).toEqual([TENANT])
    expect(subject.templateCalls).toEqual([{ tenantId: TENANT, templateId: TEMPLATE_ID }])
  })

  it('will not resolve a template for a tenant it was not composed for', async () => {
    const subject = composed()
    const result = await subject.executor.execute(emailRequest({ tenantId: OTHER_TENANT }))
    expect(result.status).toBe('failed')
    expect(subject.email).toHaveLength(0)
    expect(subject.templateCalls).toEqual([])
  })
})

describe('the executors behind the seam still tell the truth', () => {
  it('succeeds only on a confirmed booking, carrying the system reference', async () => {
    const subject = composed()
    const result = await subject.executor.execute(bookingRequest())
    expect(result.status).toBe('succeeded')
    if (result.status !== 'succeeded') return
    expect(JSON.stringify(result.output)).toContain('BOOK-1')
    expect(JSON.stringify(result.output)).not.toContain('cust-1')
  })

  it('succeeds on provider acceptance, and never claims delivery', async () => {
    const subject = composed()
    const result = await subject.executor.execute(emailRequest())
    expect(result.status).toBe('succeeded')
    if (result.status !== 'succeeded') return
    const rendered = JSON.stringify(result.output)
    expect(rendered).not.toContain('delivered')
    expect(rendered).not.toContain('guest@example.com')
  })

  it('replays the same key and payload without a second port call', async () => {
    const subject = composed()
    const first = await subject.executor.execute(bookingRequest())
    const second = await subject.executor.execute(bookingRequest())
    expect(first.status).toBe('succeeded')
    expect(second.status).toBe('succeeded')
    expect(subject.booking).toHaveLength(1)
    expect(subject.bookingClaims).toEqual(['turn-1', 'turn-1'])
  })

  it('refuses a same-key payload change rather than re-issuing it', async () => {
    const subject = composed()
    await subject.executor.execute(bookingRequest())
    const changed = await subject.executor.execute(
      bookingRequest({ inputs: { slotId: 'slot-2', customer: { customerRef: 'cust-1' } } }),
    )
    // The machine reason is the boundary's to choose; what this seam must
    // guarantee is that it is a refusal, not a second reservation.
    expect(changed.status).toBe('failed')
    if (changed.status !== 'failed') return
    expect(subject.booking).toHaveLength(1)
  })

  it('never reports an unknown outcome as a booking, and never retries it', async () => {
    const built = parts()
    built.booking.gateway = fakeBookingGateway({ outcome: 'unknown', reason: 'timeout' })
    const executor = composeTenantActExecutor({
      tenantId: TENANT,
      booking: {
        gateway: built.booking.gateway.gateway,
        store: built.booking.store.store,
        reconciler: built.booking.reconciler,
      },
      email: {
        gateway: built.email.gateway.gateway,
        store: built.email.store.store,
        status: built.email.status,
        templates: built.email.templates.resolver,
      },
      fingerprintKeys: { booking: FINGERPRINT_KEY, email: FINGERPRINT_KEY },
    })
    const result = await executor.execute(bookingRequest())
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.retryable).toBe(false)
    expect(JSON.stringify(result)).not.toContain('BOOK-')
    // One call only. The reconciler is the second look that is allowed, and it
    // answered "not found" — which is not a booking either.
    expect(built.booking.gateway.calls).toHaveLength(1)
    expect(built.booking.store.records.at(-1)?.state).toBe('unknown')
  })
})
