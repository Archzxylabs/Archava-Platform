import { describe, expect, it } from 'vitest'
import { ActionPolicy } from '@archava/acl'
import type { BrainProvider, BrainReply, BrainTurn } from '@archava/adapters'
import { parseClientConfig, type ClientConfig } from '@archava/config'
import {
  assertTenant,
  foldContextEvents,
  seedContextGraph,
  TenantScopeError,
  type ContextEvent,
  type ContextGraph,
} from '@archava/core'
import type { KnowledgeContextChunk } from '@archava/knowledge'
import { runTurn, type KnowledgePort, type TurnRequest } from '../src/index.js'

/**
 * The turn pipeline (PRD §16–§21, §23, §25–§27) as a black box.
 *
 * Everything here goes through `runTurn`, because the guarantees are properties
 * of the pipeline and not of one module: the graph is masked before the brain
 * ever sees it, an action a brain asks for is a request the gate re-decides,
 * and a component the brain invents never renders. Each test names its clause.
 */

const TENANT = 'acme-hotels'
const OCCURRED_AT = '2026-04-01T09:00:00.000Z'

function configFor(tenantId = TENANT): ClientConfig {
  return parseClientConfig({
    schema_version: '1.0.0',
    tenantId,
    environment: 'commerce_booking',
    presence: 'chat',
    capability: 'transact',
    region: 'ID',
    template: 'hospitality',
    branding: {
      businessName: 'Acme Hotels',
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
    updatedAt: '2026-04-01',
  })
}

/** The graph the SDK hands over, built by the real reducer rather than cast. */
function graph(events: readonly ContextEvent[] = [], route = '/rooms'): ContextGraph {
  return foldContextEvents(seedContextGraph(configFor(), route), events)
}

const ROOMS: ContextGraph['entities'] = [
  { id: 'room-12', name: 'Room 12', kind: 'product' },
  { id: 'room-14', name: 'Room 14', kind: 'product' },
]

const BOOK_FORM: NonNullable<ContextGraph['form']> = {
  id: 'booking_request',
  step: 'guest_details',
  completedFields: ['check_in'],
  pendingFields: ['guest_phone'],
  maskedFields: ['guest_phone'],
}

const enabled = (...names: string[]): ContextGraph['availableActions'] =>
  names.map((name) => ({ name, enabled: true }))

function chunk(sourceId: string, text = 'Acme Hotels sits two minutes from Senggigi beach.') {
  const prepared: KnowledgeContextChunk = {
    sourceId,
    sourceTitle: `Doc ${sourceId}`,
    sourceKind: 'documentation',
    text,
  }
  return prepared
}

const EMPTY_RETRIEVAL: KnowledgePort = {
  retrieve: () => ({
    plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
    context: [],
    deferToStructuredTruth: false,
  }),
}

function retrieve(...chunks: readonly { sourceId: string; text?: string }[]): KnowledgePort {
  return {
    retrieve: () => ({
      plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
      context: chunks.map((entry) => chunk(entry.sourceId, entry.text)),
      deferToStructuredTruth: false,
    }),
  }
}

function truth(values: Readonly<Record<string, unknown>>) {
  return { resolve: () => values }
}

const EMPTY_TRUTH = { resolve: () => ({}) }

/**
 * A brain that records the turn it was handed.
 *
 * `ScriptedBrain` always returns no actions and no components, which cannot
 * exercise the gate or the registry. This one keeps the turn so a test can
 * assert on the projected context and the permitted set it received, and never
 * invents a component: what the pipeline does with an invented one is tested
 * with its own brain below.
 */
function probe(reply: Partial<BrainReply> = {}): BrainProvider & {
  readonly turns: readonly BrainTurn[]
} {
  const turns: BrainTurn[] = []
  return {
    providerId: 'probe-brain',
    model: 'reference-model',
    health: { ready: true, reason: null },
    reply(turn) {
      turns.push(turn)
      return {
        text: 'Here are the two rooms closest to the beach.',
        requestedActions: [],
        citations: [],
        deferToStructuredTruth: false,
        ...reply,
      }
    },
    get turns() {
      return turns
    },
  }
}

/** A brain that asks for actions. Requests, not permissions. */
function brainFor(...actions: readonly string[]): BrainProvider {
  return {
    providerId: 'probe-brain',
    model: 'reference-model',
    health: { ready: true, reason: null },
    reply: () => ({
      text: 'On it.',
      requestedActions: actions.map((actionId) => ({ actionId, inputs: { actionId } })),
      citations: [],
      deferToStructuredTruth: false,
    }),
  }
}

/** A brain that selects generative components. Unvalidated by construction. */
function brainWithComponents(components: readonly unknown[]): BrainProvider {
  return {
    providerId: 'probe-brain',
    model: 'reference-model',
    health: { ready: true, reason: null },
    reply: () => ({
      text: 'Two rooms match.',
      requestedActions: [],
      citations: [],
      deferToStructuredTruth: false,
      components,
    }),
  }
}

/**
 * A turn request with the defaults every test shares.
 *
 * The graph and brain default too: most tests care about one clause and should
 * not have to spell out the other nine fields to reach it.
 */
function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    tenantId: TENANT,
    sessionId: 'sess_1',
    utterance: 'Which rooms are near the beach?',
    occurredAt: OCCURRED_AT,
    policy: new ActionPolicy(),
    capability: 'transact',
    role: 'archava_assistant',
    knowledge: retrieve({ sourceId: 'k1' }),
    graph: graph(),
    brain: probe(),
    ...overrides,
  }
}

/** The projected context the brain was actually handed. */
function seen(
  brain: BrainProvider & { readonly turns: readonly BrainTurn[] },
): Readonly<Record<string, unknown>> {
  const turn = brain.turns[0]
  if (turn === undefined) throw new Error('the brain was never invoked')
  return turn.context
}

/** The permitted action ids the brain was offered, in the order it got them. */
function permitted(brain: BrainProvider & { readonly turns: readonly BrainTurn[] }): readonly string[] {
  const turn = brain.turns[0]
  if (turn === undefined) throw new Error('the brain was never invoked')
  return turn.permittedActionIds
}

/** The grounding the brain was offered, and nothing else. */
function grounding(brain: BrainProvider & { readonly turns: readonly BrainTurn[] }): readonly unknown[] {
  const turn = brain.turns[0]
  if (turn === undefined) throw new Error('the brain was never invoked')
  return turn.grounding
}

describe('tenant scope (§23)', () => {
  it('throws on a cross-tenant graph rather than answering from the wrong page', () => {
    // §23: cross-tenant access is a bug, not a recoverable error. It throws — it
    // does not return empty, partial, or the other tenant's rooms.
    const foreign = seedContextGraph(configFor('other-hotels'), '/rooms')
    const brain = probe()
    expect(() => runTurn(request({ graph: foreign, brain }))).toThrow(TenantScopeError)
    expect(brain.turns).toHaveLength(0)
  })

  it('accepts the tenant it was given', () => {
    expect(assertTenant(graph(), TENANT).tenantId).toBe(TENANT)
  })

  it('scopes retrieval to the requested tenant', () => {
    const asked: string[] = []
    const brain = probe()
    runTurn(
      request({
        graph: graph(),
        brain,
        knowledge: {
          retrieve: (query) => {
            asked.push(query.tenantId)
            return {
              plan: { need: 'retrieval_knowledge', subjects: [], query: query.question },
              context: [chunk('k1')],
              deferToStructuredTruth: false,
            }
          },
        },
      }),
    )
    expect(asked).toEqual([TENANT])
    // The tenant's own chunk is what the brain was grounded on — never another
    // tenant's, and never a merged pile of both.
    expect(grounding(brain)).toEqual([chunk('k1')])
  })
})

describe('the masking boundary (§16)', () => {
  it('projects field names and never a form value', () => {
    // The graph carries field *names*; a value cannot be projected because it
    // was never carried. A pending field reaches the brain as a name only.
    const brain = probe()
    runTurn(
      request({
        graph: graph([
          { type: 'entities/set', entities: ROOMS },
          { type: 'form/set', form: BOOK_FORM },
        ]),
        brain,
      }),
    )

    const form = seen(brain).form as Record<string, unknown>
    expect(form.pendingFields).toEqual(['guest_phone'])
    expect(form.withheldFields).toEqual(['guest_phone'])
    expect(form).not.toHaveProperty('value')
    expect(JSON.stringify(seen(brain))).not.toMatch(/\+62|0812/)
  })

  it('redacts a projected key the tenant declares sensitive, and says so', () => {
    // Masking is loud when it fires: a redacted answer is distinguishable from
    // a silent one, so nobody mistakes a withheld field for a wrong one.
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'page/section', section: 'beachfront' }]),
        clientSensitiveFields: ['section'],
        brain: probe(),
      }),
    )
    expect(outcome.notices.some((notice) => notice.includes('section'))).toBe(true)
  })

  it('records no notice when nothing was withheld', () => {
    const outcome = runTurn(request({ graph: graph(), brain: probe() }))
    expect(outcome.notices).toEqual([])
  })
})

describe('structured truth (§17)', () => {
  const PRICE_QUESTION = 'How much is Room 12 per night?'
  const priceTurn = (overrides: Partial<TurnRequest> = {}): TurnRequest =>
    request({ utterance: PRICE_QUESTION, ...overrides })

  it('answers a live question from the live system, not from retrieval', () => {
    const outcome = runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'stale-price', text: 'Room 12 costs 900000 IDR.' }),
        truth: truth({ price: { amountMinor: 1_200_000, currency: 'IDR' } }),
      }),
    )
    expect(outcome.basis).toBe('structured_truth')
    expect(outcome.structuredTruth).toEqual({ price: { amountMinor: 1_200_000, currency: 'IDR' } })
    expect(outcome.knowledgeGap).toBe(false)
  })

  it('does not let retrieval become the basis when the live system is unreachable', () => {
    // §17's absolute: a price question with no live answer is not answered by a
    // chunk, however confident the chunk looks. A stale price quoted as fact is
    // the failure this clause exists to prevent.
    const outcome = runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'stale-price', text: 'Room 12 costs 900000 IDR.' }),
      }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
  })

  it('treats a live system that answered nothing as unresolved', () => {
    const outcome = runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'k1' }),
        truth: EMPTY_TRUTH,
      }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
  })

  it('classifies before retrieving, so retrieval cannot reclassify the question', () => {
    // The classifier runs first and hands the live subjects onward; retrieval
    // sees the same utterance regardless of what it decided.
    const resolved: unknown[] = []
    const outcome = runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'k1' }),
        truth: {
          resolve: (subjects) => {
            resolved.push([...subjects])
            return { price: { amountMinor: 1_200_000, currency: 'IDR' } }
          },
        },
      }),
    )
    expect(resolved).toEqual([['price']])
    expect(outcome.basis).toBe('structured_truth')
    expect(outcome.actions).toHaveLength(0)
  })

  it('answers a retrieval question from retrieval when no live system is needed', () => {
    const outcome = runTurn(
      request({
        utterance: 'Which rooms are near the beach?',
        graph: graph(),
        brain: probe({ citations: [{ sourceId: 'k1', sourceTitle: 'Doc k1' }] }),
        truth: truth({ price: { amountMinor: 999_999 } }),
      }),
    )
    expect(outcome.basis).toBe('retrieval')
    expect(outcome.structuredTruth).toEqual({})
    expect(outcome.knowledgeGap).toBe(false)
  })

  it('records a knowledge gap when retrieval came back empty', () => {
    const outcome = runTurn(
      request({ graph: graph(), brain: probe(), knowledge: EMPTY_RETRIEVAL }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
  })

  it('survives a retrieval system that throws', () => {
    // An unreachable knowledge system is a reported gap, not a crashed turn and
    // not a confident guess. The visitor still gets an answer.
    const outcome = runTurn(
      request({
        graph: graph(),
        brain: probe({ text: 'I could not find that.' }),
        knowledge: {
          retrieve: () => {
            throw new Error('store offline')
          },
        },
      }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
    expect(outcome.text).toBe('I could not find that.')
  })
})

describe('the policy gate (§18)', () => {
  it('gives the brain only what the capability, role, and page allow', () => {
    const brain = probe()
    runTurn(
      request({
        graph: graph([
          { type: 'action/set', actions: enabled('order.status.read', 'cart.item.add') },
        ]),
        brain,
      }),
    )
    expect(permitted(brain)).toEqual(['order.status.read', 'cart.item.add'])
  })

  it('narrows what the page offers without ever widening it', () => {
    // `enabled: false` removes an action. The page cannot add one that the
    // capability tier did not already permit.
    const brain = probe()
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: [{ name: 'order.status.read', enabled: false }] }]),
        brain,
      }),
    )
    expect(permitted(brain)).toEqual([])
    expect(outcome.permittedActionIds).toEqual([])
  })

  it('lets a page that says nothing narrow nothing further', () => {
    // A page that omits an action has not declared it unavailable: the client
    // allow-list already failed closed, so the narrowing signal is explicit
    // refusal rather than silence.
    const brain = probe()
    runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain,
      }),
    )
    expect(permitted(brain)).toEqual(['order.status.read'])
  })

  it('denies an action the brain invented, without taking the turn down', () => {
    // A model that names an action has not thereby claimed the tier it needs.
    const outcome = runTurn(
      request({ graph: graph(), brain: brainFor('booking.cancel_with_refund') }),
    )
    expect(outcome.actions).toHaveLength(1)
    expect(outcome.actions[0]?.decision).toBe('denied')
    expect(outcome.actions[0]?.ran).toBe(false)
    expect(outcome.actions[0]?.reason).toContain('No action "booking.cancel_with_refund"')
    expect(outcome.handoff?.reason).toBe('capability_exceeded')
  })

  it('holds an unconfirmed L3 action at confirmation_required and does not run it', () => {
    // §18: capability tier does not override risk rules. A Transact client still
    // needs to confirm an L3 action — while the L0 read beside it runs free.
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('booking.create', 'order.status.read') }]),
        brain: brainFor('booking.create', 'order.status.read'),
      }),
    )
    const booking = outcome.actions.find((action) => action.actionId === 'booking.create')
    expect(booking?.decision).toBe('confirmation_required')
    expect(booking?.ran).toBe(false)
    expect(booking?.reason).toBe('Confirmation required via user_confirm.')
    expect(booking?.prompt).toContain('booking.create')

    const read = outcome.actions.find((action) => action.actionId === 'order.status.read')
    expect(read?.decision).toBe('allow')
    expect(read?.ran).toBe(true)
  })

  it('runs the same action once the visitor confirmed it', () => {
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('booking.create') }]),
        brain: brainFor('booking.create'),
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]?.decision).toBe('allow')
    expect(outcome.actions[0]?.ran).toBe(true)
  })

  it('refuses an L5 admin action unless a human approved it', () => {
    // "Never autonomous" means the confirmation mode is not enough: a human must
    // have actually approved it, by id, for this session. The session role is
    // admin, because an assistant role may not invoke it at all (§18).
    const graphWithAdmin = () =>
      graph([{ type: 'action/set', actions: enabled('admin.config.update') }])

    const denied = runTurn(
      request({ graph: graphWithAdmin(), brain: brainFor('admin.config.update'), role: 'admin' }),
    )
    expect(denied.actions[0]?.decision).toBe('denied')
    expect(denied.actions[0]?.ran).toBe(false)
    expect(denied.actions[0]?.reason).toContain('never runs autonomously')

    const approved = runTurn(
      request({
        graph: graphWithAdmin(),
        brain: brainFor('admin.config.update'),
        role: 'admin',
        confirmedActionIds: ['admin.config.update'],
        humanApprovedActionIds: ['admin.config.update'],
      }),
    )
    expect(approved.actions[0]?.decision).toBe('allow')
    expect(approved.actions[0]?.ran).toBe(true)
  })

  it('reads the action definition tier for the gate, not the client tier', () => {
    // The client is Transact; `order.status.read` needs Assist. The permitted
    // set is derived from the client's tier, and the per-action decision from
    // the action's own requirement — so a tier can never quietly widen a check.
    const brain = probe()
    runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        capability: 'assist',
        brain,
      }),
    )
    expect(permitted(brain)).toEqual(['order.status.read'])
  })

  it('keeps a denied action out of the permitted set it offered the brain', () => {
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        capability: 'assist',
        brain: brainFor('order.status.read'),
      }),
    )
    expect(outcome.permittedActionIds).toEqual(['order.status.read'])
    expect(outcome.actions[0]?.decision).toBe('allow')
  })
})

describe('generative UI (§25)', () => {
  const cta = (actionId: string): { kind: string; props: Record<string, unknown> } => ({
    kind: 'cta',
    props: { label: 'Book', actionId },
  })

  it('keeps a component the registry accepts', () => {
    const outcome = runTurn(
      request({
        graph: graph(),
        brain: brainWithComponents([
          { kind: 'recommendation_list', props: { items: [{ entityId: 'room-12', entityName: 'Room 12', reason: 'closest', sourceId: null }] } },
        ]),
      }),
    )
    expect(outcome.components).toHaveLength(1)
    expect(outcome.components[0]?.kind).toBe('recommendation_list')
    expect(outcome.rejectedComponents).toEqual([])
  })

  it('rejects an invented kind and reports why instead of rendering it', () => {
    // Model output selects from a registry. It does not execute arbitrary
    // client-side code, so an unknown kind never becomes a component.
    const outcome = runTurn(
      request({ graph: graph(), brain: brainWithComponents([{ kind: 'arbitrary_widget', props: {} }]) }),
    )
    expect(outcome.components).toEqual([])
    expect(outcome.rejectedComponents).toHaveLength(1)
    expect(outcome.rejectedComponents[0]).toContain('arbitrary_widget')
  })

  it('drops a CTA whose action the gate did not permit, keeping its siblings', () => {
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainWithComponents([
          cta('admin.config.update'),
          { kind: 'faq_source_card', props: { sourceId: 's1', sourceTitle: 'Policy', excerpt: 'Check-in is 14:00.' } },
        ]),
      }),
    )
    // The card runs nothing, so the gate does not touch it.
    expect(outcome.components.map((component) => component.kind)).toEqual(['faq_source_card'])
  })
})

describe('handoff and events (§26, §27)', () => {
  it('hands over with the story the visitor should not have to repeat', () => {
    const outcome = runTurn(
      request({
        graph: graph([
          { type: 'entities/select', entityId: 'room-12' },
          { type: 'session/authenticated', role: 'guest', customerRef: 'cust_9' },
          { type: 'error/recorded', code: 'booking_slot_unavailable', occurredAt: OCCURRED_AT },
        ]),
        brain: probe(),
        handoffRequested: true,
      }),
    )
    expect(outcome.handoff).not.toBeNull()
    expect(outcome.handoff?.reason).toBe('visitor_requested')
    expect(outcome.handoff?.route).toBe('/rooms')
    expect(outcome.handoff?.locale).toBe('id')
    // Identity is shared only where the authenticated session permits it.
    expect(outcome.handoff?.customerRef).toBe('cust_9')
    expect(outcome.handoff?.errors).toEqual([
      { code: 'booking_slot_unavailable', message: `Recorded at ${OCCURRED_AT}.` },
    ])
  })

  it('withholds identity from an anonymous visitor', () => {
    const outcome = runTurn(
      request({ graph: graph(), brain: probe(), handoffRequested: true }),
    )
    expect(outcome.handoff?.customerRef).toBeUndefined()
    expect('customerRef' in (outcome.handoff ?? {})).toBe(false)
  })

  it('escalates after repeated failure without being asked', () => {
    // Three asks, none of which went through: nothing the visitor did worked,
    // which is its own reason to escalate even though no capability was denied.
    const outcome = runTurn(
      request({
        graph: graph([
          {
            type: 'action/set',
            actions: enabled('booking.create', 'booking.reschedule', 'checkout.start'),
          },
        ]),
        brain: brainFor('booking.create', 'booking.reschedule', 'checkout.start'),
      }),
    )
    expect(outcome.actions.every((action) => action.decision === 'confirmation_required')).toBe(true)
    expect(outcome.handoff?.reason).toBe('repeated_failure')
  })

  it('emits the events the turn earned', () => {
    const outcome = runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('admin.config.update'),
        utterance: 'Which rooms are near the beach?',
      }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toContain('meaningful_question_answered')
    expect(names).toContain('tool_failure')
    expect(outcome.events.find((event) => event.name === 'tool_failure')?.note).toBe(
      'admin.config.update',
    )
    expect(names).not.toContain('knowledge_gap')
  })

  it('emits a knowledge gap and stays quiet when there is no answer', () => {
    const outcome = runTurn(
      request({ graph: graph(), brain: probe({ text: '' }), knowledge: EMPTY_RETRIEVAL }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toEqual(['knowledge_gap'])
  })
})
