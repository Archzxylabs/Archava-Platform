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
import { ActActionExecutor } from '../src/index.js'

const TENANT = 'pilot-hotel'
const TEMPLATE: ApprovedEmailTemplate = {
  tenantId: TENANT,
  templateId: 'booking-confirmation',
  providerTemplateId: 'trusted-template',
  senderAddress: 'receipts@example.com',
  approved: true,
}

function fixture() {
  const bookings: BookingReservationRequest[] = []
  const emails: EmailSendRequest[] = []
  const booking: BookingGateway = {
    gatewayId: 'fake-booking',
    health: { ready: true, reason: 'ready' },
    reserve(call) {
      bookings.push(call)
      return Promise.resolve({ outcome: 'confirmed', bookingReference: 'BOOK-1' })
    },
  }
  const email: EmailGateway = {
    send(call) {
      emails.push(call)
      return Promise.resolve({ outcome: 'accepted', providerMessageId: 'MSG-1' })
    },
  }
  const executor = new ActActionExecutor(
    new BookingActionExecutor({ gateway: booking }),
    new EmailActionExecutor({
      templates: {
        resolve(tenantId, templateId) {
          return Promise.resolve(
            tenantId === TENANT && templateId === TEMPLATE.templateId ? TEMPLATE : null,
          )
        },
      },
      gateway: email,
    }),
  )
  return { executor, bookings, emails }
}

const resolver: EntityResolver = {
  resolveExists(tenantId, kind, id) {
    const entries: Readonly<Record<string, readonly string[]>> = {
      slot: ['slot-1'],
      customer: ['cust-1'],
      template: ['booking-confirmation'],
    }
    return Promise.resolve(tenantId === TENANT && (entries[kind] ?? []).includes(String(id)))
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

function turn(
  action: 'booking.create' | 'email.send',
  inputs: Readonly<Record<string, unknown>>,
  overrides: Partial<TurnRequest> = {},
): TurnRequest {
  const config = parseClientConfig({
    schema_version: '1.0.0',
    tenantId: TENANT,
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
  const graph = foldContextEvents(seedContextGraph(config, '/rooms'), [
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
    tenantId: TENANT,
    sessionId: 'session-1',
    utterance: 'Please process the selected request.',
    occurredAt: '2026-09-27T00:00:00.000Z',
    graph,
    brain,
    policy: new ActionPolicy(),
    knowledge,
    capability: 'act',
    role: 'archava_assistant',
    resolver,
    ...overrides,
  }
}

const bookingInputs = { slotId: 'slot-1', customer: { customerRef: 'cust-1' } }
const emailInputs = { templateId: 'booking-confirmation', to: 'guest@example.com' }

describe('Act pilot through the real turn pipeline', () => {
  it('creates a booking only after Act policy, confirmation and entity validation', async () => {
    const subject = fixture()
    const outcome = await runTurn(
      turn('booking.create', bookingInputs, {
        executor: subject.executor,
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]).toMatchObject({
      policy: 'allowed',
      execution: 'succeeded',
      output: { bookingReference: 'BOOK-1', status: 'confirmed' },
    })
    expect(subject.bookings).toHaveLength(1)
    expect(subject.emails).toHaveLength(0)
  })

  it('Assist, missing confirmation, absent resolver, and invalid entity block booking', async () => {
    for (const override of [
      { capability: 'assist' as const, confirmedActionIds: ['booking.create'] },
      { confirmedActionIds: [] },
      { confirmedActionIds: ['booking.create'], resolver: undefined },
      {
        confirmedActionIds: ['booking.create'],
        resolver: { resolveExists: () => Promise.resolve(false) },
      },
    ]) {
      const subject = fixture()
      const outcome = await runTurn(
        turn('booking.create', bookingInputs, {
          executor: subject.executor,
          ...override,
        }),
      )
      expect(outcome.actions[0]?.execution).toBe('not_attempted')
      expect(subject.bookings).toHaveLength(0)
    }
  })

  it('sends only an approved template after confirmation and trusted template resolution', async () => {
    const subject = fixture()
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

  it('blocks email before consent or entity validation and rejects untrusted body', async () => {
    for (const [inputs, override] of [
      [emailInputs, { capability: 'assist', confirmedActionIds: ['email.send'] }],
      [emailInputs, { confirmedActionIds: [] }],
      [emailInputs, { confirmedActionIds: ['email.send'], resolver: undefined }],
      [{ ...emailInputs, body: 'model-written text' }, { confirmedActionIds: ['email.send'] }],
    ] as const) {
      const subject = fixture()
      const outcome = await runTurn(
        turn('email.send', inputs, {
          executor: subject.executor,
          ...override,
        }),
      )
      expect(outcome.actions[0]?.execution).toBe('not_attempted')
      expect(subject.emails).toHaveLength(0)
    }
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
