/**
 * The full pipeline, against both the tenant-bound composition and the raw
 * unwired dispatcher.
 *
 * These cases exist to prove the composition seam makes no authorization claim
 * of its own: every refusal that matters still happens upstream — in policy, in
 * confirmation, in validation, in entity resolution — and nothing downstream
 * rewrites it.
 */

import { describe, expect, it } from 'vitest'
import { ActionPolicy } from '@archava/acl'
import {
  BookingActionExecutor,
  type BookingGateway,
  type BookingReservationRequest,
} from '@archava/act-booking'
import {
  EmailActionExecutor,
  type ApprovedEmailTemplate,
  type EmailGateway,
  type EmailSendRequest,
} from '@archava/act-email'
import type { BrainProvider } from '@archava/adapters'
import { runTurn, type TurnRequest, type EntityResolver } from '@archava/assistant'
import { parseClientConfig } from '@archava/config'
import { foldContextEvents, seedContextGraph } from '@archava/core'
import type { KnowledgePort } from '@archava/assistant'
import { ActActionExecutor, composeTenantActExecutor } from '../src/index.js'
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
} from './fakes.js'

const TEMPLATE: ApprovedEmailTemplate = {
  tenantId: TENANT,
  templateId: 'booking-confirmation',
  providerTemplateId: 'trusted-template',
  senderAddress: 'receipts@example.com',
  approved: true,
}

const bookingInputs = { slotId: 'slot-1', customer: { customerRef: 'cust-1' } }
const emailInputs = { templateId: TEMPLATE.templateId, to: 'guest@example.com' }

/** An unwired pair of raw executors, dispatched directly. */
function fixture() {
  const bookings: BookingReservationRequest[] = []
  const emails: EmailSendRequest[] = []
  const booking: BookingGateway = {
    gatewayId: 'raw-booking',
    health: { ready: true, reason: 'ready' },
    reserve(request) {
      bookings.push(request)
      return Promise.resolve({ outcome: 'confirmed', bookingReference: 'BOOK-1' })
    },
  }
  const email: EmailGateway = {
    send(request) {
      emails.push(request)
      return Promise.resolve({ outcome: 'accepted', providerMessageId: 'MSG-1' })
    },
  }
  const executor = new ActActionExecutor(
    new BookingActionExecutor({ gateway: booking }),
    new EmailActionExecutor({
      templates: {
        resolve() {
          return Promise.resolve(TEMPLATE)
        },
      },
      gateway: email,
    }),
  )
  return { executor, bookings, emails }
}

/** The composition seam, wired from the injected fakes. */
function configuration() {
  const booking = fakeBookingGateway({ outcome: 'confirmed', bookingReference: 'BOOK-1' })
  const bookingStore = fakeBookingStore()
  const email = fakeEmailGateway({ outcome: 'accepted', providerMessageId: 'MSG-1' })
  const emailStore = fakeEmailStore()
  const templates = fakeTemplateResolver()
  const executor = composeTenantActExecutor({
    tenantId: TENANT,
    booking: {
      gateway: booking.gateway,
      store: bookingStore.store,
      reconciler: fakeReconciler({ outcome: 'rejected', reason: 'attempt_not_found' }),
    },
    email: {
      gateway: email.gateway,
      store: emailStore.store,
      status: fakeStatusPort({ outcome: 'rejected', reason: 'status_not_available' }),
      templates: templates.resolver,
    },
    fingerprintKeys: { booking: FINGERPRINT_KEY, email: FINGERPRINT_KEY },
  })
  return { executor, bookings: booking.calls, emails: email.calls }
}

/**
 * A catalog that answers for whichever tenant the turn was built for.
 *
 * It resolves `OTHER_TENANT` too, deliberately: the mismatched-tenant case has
 * to be answered by the composition's own binding rather than by a resolver that
 * happens to know nothing about the other tenant. A resolver scoped to one
 * tenant would fail the resolution first, and the test would then be proving the
 * resolver's care instead of the executor's.
 */
const resolver: EntityResolver = {
  resolveExists(tenantId, kind, id) {
    const entries: Readonly<Record<string, readonly string[]>> = {
      slot: ['slot-1'],
      customer: ['cust-1'],
      template: [TEMPLATE.templateId],
    }
    const known = [TENANT, OTHER_TENANT]
    return Promise.resolve(known.includes(tenantId) && (entries[kind] ?? []).includes(String(id)))
  },
}

const knowledge: KnowledgePort = {
  retrieve() {
    return Promise.resolve({
      plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
      context: [],
      deferToStructuredTruth: false,
    })
  },
}

/** The client configuration for one tenant, whose capability tier is `act`. */
function clientConfigFor(tenantId: string) {
  return parseClientConfig({
    schema_version: '1.0.0',
    tenantId,
    environment: 'commerce_booking',
    presence: 'chat',
    capability: 'act',
    region: 'ID',
    template: 'hospitality',
    branding: {
      businessName: 'Pilot Hotel',
      theme: {
        accent: '#123456',
        surface: '#ffffff',
        ink: '#101010',
        radius: 'rounded',
        fontFamily: 'Inter',
      },
    },
    languages: [{ code: 'id', label: 'Bahasa Indonesia' }],
    primaryLanguage: 'id',
    updatedAt: '2026-09-27',
  })
}

/**
 * A whole turn, built for one tenant.
 *
 * The tenant is a parameter rather than a constant because a request addressed
 * to another tenant is a turn *built for* that tenant — its config, its graph,
 * its resolver — not the same turn with one field overwritten. The graph is
 * scoped to the same tenant because `runTurn` refuses a graph that belongs to
 * anyone else before it reaches the executor at all, which would prove nothing
 * about the composition.
 */
function turn(
  action: 'booking.create' | 'email.send',
  inputs: Readonly<Record<string, unknown>>,
  overrides: Partial<TurnRequest> = {},
  tenantId: string = TENANT,
): TurnRequest {
  const graph = foldContextEvents(seedContextGraph(clientConfigFor(tenantId), '/rooms'), [
    { type: 'action/set', actions: [{ name: action, enabled: true }] },
  ])
  const brain: BrainProvider = {
    providerId: 'scripted-test-brain',
    model: 'fixed',
    health: { ready: true, reason: null },
    reply() {
      return Promise.resolve({
        text: 'Processing your request.',
        requestedActions: [{ actionId: action, inputs }],
        citations: [],
        deferToStructuredTruth: false,
      })
    },
  }
  return {
    tenantId,
    sessionId: 'session-1',
    utterance: 'Please process the selected request.',
    occurredAt: '2026-09-27T00:00:00.000Z',
    // The tier and the role are the client's own, which is what the policy gate
    // weighs the action's requirement against. Both are stated here so that a
    // positive case really is allowed for the reason it claims to be.
    capability: 'act',
    role: 'archava_assistant',
    graph,
    brain,
    policy: new ActionPolicy(),
    resolver,
    knowledge,
    ...overrides,
  }
}

describe('runTurn against the tenant-bound composition', () => {
  it('succeeds only when policy, confirmation, validation and resolution all hold', async () => {
    const subject = configuration()
    const outcome = await runTurn(
      turn('booking.create', bookingInputs, {
        executor: subject.executor,
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]).toMatchObject({ policy: 'allowed', execution: 'succeeded' })
    expect(subject.bookings).toHaveLength(1)
    expect(subject.bookings[0]).toMatchObject({
      tenantId: TENANT,
      slotId: 'slot-1',
      customerRef: 'cust-1',
    })
  })

  it('does not let the composition seam restore a capability it does not own', async () => {
    // Assist tier and unconfirmed Act still refuse. The tenant binding is a
    // deployment statement, not a capability.
    for (const override of [
      { capability: 'assist', confirmedActionIds: ['booking.create'] },
      { confirmedActionIds: [] },
      { confirmedActionIds: ['email.send'] },
    ] as const) {
      const subject = configuration()
      const outcome = await runTurn(
        turn('booking.create', bookingInputs, {
          executor: subject.executor,
          ...override,
        }),
      )
      expect(outcome.actions[0]?.execution).not.toBe('succeeded')
      expect(subject.bookings).toHaveLength(0)
    }
  })

  it('does not let the composition seam override a failed entity resolution', async () => {
    const subject = configuration()
    const outcome = await runTurn(
      turn(
        'booking.create',
        { slotId: 'slot-missing', customer: { customerRef: 'cust-1' } },
        {
          executor: subject.executor,
          confirmedActionIds: ['booking.create'],
          resolver: {
            resolveExists() {
              return Promise.resolve(false)
            },
          },
        },
      ),
    )
    // Denied before execution, never reached: the executor is below §9, so a
    // slot nobody can resolve is a refusal on the record rather than an attempt.
    expect(outcome.actions[0]).toMatchObject({ policy: 'denied', execution: 'not_attempted' })
    expect(subject.bookings).toHaveLength(0)
  })

  it('refuses a turn that was built for a tenant it was never configured for', async () => {
    // Every field of the turn is the other tenant's: its config, its graph, its
    // resolver answers. Only the executor is this one, and the binding holds.
    const subject = configuration()
    const outcome = await runTurn(
      turn(
        'booking.create',
        bookingInputs,
        {
          executor: subject.executor,
          confirmedActionIds: ['booking.create'],
        },
        OTHER_TENANT,
      ),
    )
    expect(outcome.actions[0]?.execution).not.toBe('succeeded')
    expect(subject.bookings).toHaveLength(0)
    expect(subject.executor.tenantId).toBe(TENANT)
  })

  it('sends only an approved template, after confirmation and resolution', async () => {
    const subject = configuration()
    const outcome = await runTurn(
      turn('email.send', emailInputs, {
        executor: subject.executor,
        confirmedActionIds: ['email.send'],
      }),
    )
    expect(outcome.actions[0]).toMatchObject({
      policy: 'allowed',
      execution: 'succeeded',
      output: { deliveryStatus: 'accepted', providerMessageId: 'MSG-1' },
    })
    expect(subject.emails).toHaveLength(1)
    expect(subject.bookings).toHaveLength(0)
    expect(JSON.stringify(outcome.actions[0]?.output)).not.toContain('guest@example.com')
    expect(JSON.stringify(outcome.actions[0]?.output)).not.toContain('delivered')
  })

  it('blocks email before consent or validation, and rejects untrusted body', async () => {
    for (const [inputs, override] of [
      [emailInputs, { capability: 'assist', confirmedActionIds: ['email.send'] }],
      [emailInputs, { confirmedActionIds: [] }],
      [emailInputs, { confirmedActionIds: ['email.send'], resolver: undefined }],
      [{ ...emailInputs, body: 'model-written text' }, { confirmedActionIds: ['email.send'] }],
    ] as const) {
      const subject = configuration()
      const outcome = await runTurn(
        turn('email.send', inputs, {
          executor: subject.executor,
          ...override,
        }),
      )
      expect(outcome.actions[0]?.execution).not.toBe('succeeded')
      expect(subject.emails).toHaveLength(0)
    }
  })
})

describe('runTurn against the raw dispatcher', () => {
  it('still books a confirmed reservation', async () => {
    const subject = fixture()
    const outcome = await runTurn(
      turn('booking.create', bookingInputs, {
        executor: subject.executor,
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]).toMatchObject({ policy: 'allowed', execution: 'succeeded' })
    expect(subject.bookings).toHaveLength(1)
  })

  it('without any executor, an allowed booking remains not attempted', async () => {
    const outcome = await runTurn(
      turn('booking.create', bookingInputs, {
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]).toMatchObject({ policy: 'allowed', execution: 'not_attempted' })
  })
})
