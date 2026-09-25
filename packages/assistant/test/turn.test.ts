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
import type {
  KnowledgeContextChunk,
  RetrievalOutcome,
  StructuredTruthSubject,
} from '@archava/knowledge'
import {
  runTurn,
  type KnowledgePort,
  type StructuredTruthPort,
  type TurnRequest,
} from '../src/index.js'
import type { ActionExecutor } from '../src/execution.js'
import type { EntityResolver } from '../src/validation.js'

/**
 * The turn pipeline (PRD §16–§21, §23, §25–§27) as a black box.
 *
 * Everything here goes through `runTurn`, because the guarantees are properties
 * of the pipeline and not of one module: the graph is masked before the brain
 * ever sees it, an action a brain asks for is a request the gate re-decides, and
 * a component the brain invents never renders. Each test names its clause.
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
  retrieve: (): Promise<RetrievalOutcome> =>
    Promise.resolve({
      plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
      context: [],
      deferToStructuredTruth: false,
    }),
}

function retrieve(...chunks: readonly { sourceId: string; text?: string }[]): KnowledgePort {
  return {
    retrieve: (): Promise<RetrievalOutcome> =>
      Promise.resolve({
        plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
        context: chunks.map((entry) => chunk(entry.sourceId, entry.text)),
        deferToStructuredTruth: false,
      }),
  }
}

/** A truth port that answers immediately, as a fixture store would. */
function truth(values: Readonly<Record<string, unknown>>): StructuredTruthPort {
  return {
    resolve: (): Promise<Readonly<Record<string, unknown>>> => Promise.resolve(values),
  }
}

/**
 * A truth port that answers on a later microtask.
 *
 * Not decorative. These regressions only hold if the port genuinely hands back
 * control before it answers: a port typed `T | Promise<T>` lets a caller read a
 * plain record without awaiting, and the only test that can tell the difference
 * is one whose answer is not already there when the call returns.
 */
function deferredTruth(
  values: Readonly<Record<string, unknown>>,
): StructuredTruthPort & { readonly settled: number } {
  const port = {
    settled: 0,
    async resolve(): Promise<Readonly<Record<string, unknown>>> {
      await Promise.resolve()
      port.settled += 1
      return values
    },
  }
  return port
}

const EMPTY_TRUTH: StructuredTruthPort = {
  resolve: (): Promise<Readonly<Record<string, unknown>>> => Promise.resolve({}),
}

/** The inputs §9 accepts, keyed by action id. */
const VALID_INPUTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'product.read': { productId: 'room-12' },
  'availability.read': { subjectId: 'slot_1' },
  'order.status.read': { orderReference: 'ORD-1' },
  'cart.item.add': { productId: 'room-12', quantity: 2 },
  'cart.item.remove': { productId: 'room-12' },
  'booking.create': { slotId: 'slot_1', customer: { customerRef: 'cust_9' } },
  'booking.reschedule': { bookingId: 'book_1', slotId: 'slot_2' },
  'email.send': { templateId: 'tpl_1', to: 'guest@example.com' },
  'form.submit': { formId: 'booking_request', fields: { check_in: '2026-05-01' } },
  'admin.config.update': { changes: { presence: 'chat' } },
}

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
      return Promise.resolve({
        text: 'Here are the two rooms closest to the beach.',
        requestedActions: [],
        citations: [],
        deferToStructuredTruth: false,
        ...reply,
      })
    },
    get turns() {
      return turns
    },
  }
}

/**
 * A brain that asks for actions with inputs that pass §9's contracts.
 *
 * Override the inputs only when a test is about a contract refusal; a test that
 * is about the gate should not be refused for an unrelated reason.
 */
function brainFor(...actions: readonly string[]): BrainProvider {
  return {
    providerId: 'probe-brain',
    model: 'reference-model',
    health: { ready: true, reason: null },
    reply() {
      return Promise.resolve({
        text: 'On it.',
        requestedActions: actions.map((actionId) => ({
          actionId,
          inputs: VALID_INPUTS[actionId] ?? {},
        })),
        citations: [],
        deferToStructuredTruth: false,
      })
    },
  }
}

/** A brain that selects generative components. Unvalidated by construction. */
function brainWithComponents(components: readonly unknown[]): BrainProvider {
  return {
    providerId: 'probe-brain',
    model: 'reference-model',
    health: { ready: true, reason: null },
    reply() {
      return Promise.resolve({
        text: 'Two rooms match.',
        requestedActions: [],
        citations: [],
        deferToStructuredTruth: false,
        components,
      })
    },
  }
}

/**
 * An executor that reports success for everything, recording what it got.
 *
 * Used by the tests that assert an execution actually happened: without one the
 * pipeline is honest about `not_attempted`, which is the right answer but cannot
 * demonstrate §18's executor path.
 */
function executor(
  handler?: (request: { action: string; inputs: Readonly<Record<string, unknown>> }) => void,
): ActionExecutor & {
  readonly calls: readonly { action: string; inputs: Readonly<Record<string, unknown>> }[]
} {
  const calls: { action: string; inputs: Readonly<Record<string, unknown>> }[] = []
  return {
    executorId: 'probe-executor',
    execute(request) {
      const entry = { action: request.action, inputs: request.inputs }
      calls.push(entry)
      handler?.(entry)
      return Promise.resolve({ status: 'succeeded', output: { ok: true } })
    },
    get calls() {
      return calls
    },
  }
}

/** A resolver that answers "exists" for a fixed set of kinds and ids. */
function resolverFor(existing: Readonly<Record<string, readonly string[]>>): EntityResolver {
  return {
    resolveExists: (_tenantId, entityKind, entityId): Promise<boolean> =>
      Promise.resolve((existing[entityKind] ?? []).includes(String(entityId))),
  }
}
/**
 * A resolver that confirms whatever it is asked about.
 *
 * Only for tests that reach the gate, the executor or the event boundary with an
 * entity-bearing action and are *not* about §9 — supplying this is what lets them
 * stay on their subject now that an action naming an entity without a resolver is
 * refused. It is deliberately not the default in `request()`: a resolver nobody
 * had to name was exactly how the validation gate came to be fail-open, and a
 * fixture that answers yes to everything should stay as explicit in the file as it
 * is untrustworthy as a catalog.
 */
const CONFIRMING: EntityResolver = {
  resolveExists: (): Promise<boolean> => Promise.resolve(true),
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
function permitted(
  brain: BrainProvider & { readonly turns: readonly BrainTurn[] },
): readonly string[] {
  const turn = brain.turns[0]
  if (turn === undefined) throw new Error('the brain was never invoked')
  return turn.permittedActionIds
}

/** The grounding the brain was offered, and nothing else. */
function grounding(
  brain: BrainProvider & { readonly turns: readonly BrainTurn[] },
): readonly unknown[] {
  const turn = brain.turns[0]
  if (turn === undefined) throw new Error('the brain was never invoked')
  return turn.grounding
}

describe('tenant scope (§23)', () => {
  it('throws on a cross-tenant graph rather than answering from the wrong page', async () => {
    // §23: cross-tenant access is a bug, not a recoverable error. It throws — it
    // does not return empty, partial, or the other tenant's rooms.
    const foreign = seedContextGraph(configFor('other-hotels'), '/rooms')
    const brain = probe()
    await expect(runTurn(request({ graph: foreign, brain }))).rejects.toThrow(TenantScopeError)
    expect(brain.turns).toHaveLength(0)
  })

  it('accepts the tenant it was given', () => {
    expect(assertTenant(graph(), TENANT).tenantId).toBe(TENANT)
  })

  it('scopes retrieval to the requested tenant', async () => {
    const asked: string[] = []
    const brain = probe()
    await runTurn(
      request({
        graph: graph(),
        brain,
        knowledge: {
          retrieve: (query): Promise<RetrievalOutcome> => {
            asked.push(query.tenantId)
            return Promise.resolve({
              plan: { need: 'retrieval_knowledge', subjects: [], query: query.question },
              context: [chunk('k1')],
              deferToStructuredTruth: false,
            })
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
  it('projects field names and never a form value', async () => {
    // The graph carries field *names*; a value cannot be projected because it
    // was never carried. A pending field reaches the brain as a name only.
    const brain = probe()
    await runTurn(
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

  it('redacts a projected key the tenant declares sensitive, and says so', async () => {
    // Masking is loud when it fires: a redacted answer is distinguishable from
    // a silent one, so nobody mistakes a withheld field for a wrong one.
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'page/section', section: 'beachfront' }]),
        clientSensitiveFields: ['section'],
        brain: probe(),
      }),
    )
    expect(outcome.notices.some((notice) => notice.includes('section'))).toBe(true)
  })

  it('records no notice when nothing was withheld', async () => {
    const outcome = await runTurn(request({ graph: graph(), brain: probe() }))
    expect(outcome.notices).toEqual([])
  })
})

describe('async ports (V1.1)', () => {
  const PRICE_QUESTION = 'How much is Room 12 per night?'

  it('reads a truth answer that arrives after the call returns', async () => {
    // The regression that matters. A port typed `T | Promise<T>` lets a caller
    // consume the record without awaiting, and with a synchronous double that
    // mistake is invisible: the value is already there. This port does not
    // answer until a microtask later, so any pipeline that skipped the `await`
    // would read `undefined` from the record and — worse — treat `Object.keys()`
    // of a promise as an answered subject set.
    const port = deferredTruth({ price: { amountMinor: 1_200_000, currency: 'IDR' } })
    const outcome = await runTurn(
      request({
        utterance: PRICE_QUESTION,
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'stale-price', text: 'Room 12 costs 900000 IDR.' }),
        truth: port,
      }),
    )
    expect(port.settled).toBe(1)
    expect(outcome.basis).toBe('structured_truth')
    expect(outcome.structuredTruth).toEqual({ price: { amountMinor: 1_200_000, currency: 'IDR' } })
    // The stale chunk was fetched but never became the answer.
    expect(outcome.knowledgeGap).toBe(false)
    expect(outcome.knowledgeGap).toBe(outcome.basis === 'none')
  })

  it('reads retrieval context that arrives after the call returns', async () => {
    const knowledge: KnowledgePort = {
      async retrieve(): Promise<RetrievalOutcome> {
        await Promise.resolve()
        return {
          plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
          context: [chunk('k1')],
          deferToStructuredTruth: false,
        }
      },
    }
    const brain = probe()
    const outcome = await runTurn(
      request({ utterance: 'What is the cancellation policy?', graph: graph(), brain, knowledge }),
    )
    expect(outcome.basis).toBe('retrieval')
    expect(grounding(brain)).toEqual([chunk('k1')])
  })

  it('records a knowledge gap when the truth port rejects, not a fallback answer', async () => {
    // An unreachable live system is the §17 case, not a licence to answer from
    // retrieval. The rejection has to be caught by the pipeline, which means it
    // has to be a real rejected promise rather than a synchronous throw.
    const outcome = await runTurn(
      request({
        utterance: PRICE_QUESTION,
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'stale-price', text: 'Room 12 costs 900000 IDR.' }),
        truth: {
          async resolve(): Promise<Readonly<Record<string, unknown>>> {
            await Promise.resolve()
            throw new Error('pricing service unreachable')
          },
        },
      }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
    // Empty, not absent: the field is always a record, so "no live answer" is
    // expressed as no keys rather than a hole a caller has to check for.
    expect(outcome.structuredTruth).toEqual({})
    expect(outcome.text).not.toContain('900000')
  })

  it('withholds retrieval from the brain on an unanswered live-value turn', async () => {
    // The guard above passes for the wrong reason with a brain that cannot read
    // what it was handed: `probe()` returns a fixed string, so a pipeline that
    // passed the stale chunk along would still produce an answer with no price
    // in it. This brain is shaped like the `ScriptedBrain` fallback — it quotes
    // `turn.grounding[0].text` verbatim whenever it is handed one — so the only
    // thing standing between a rejected truth port and a quoted stale price is
    // whether §17's withholding held at the call site.
    const turns: BrainTurn[] = []
    const quoting: BrainProvider & { readonly turns: readonly BrainTurn[] } = {
      providerId: 'quoting-brain',
      model: 'reference-model',
      health: { ready: true, reason: null },
      reply(turn) {
        turns.push(turn)
        const first = turn.grounding[0]
        return Promise.resolve({
          text: first === undefined ? '' : first.text,
          requestedActions: [],
          citations: [],
          deferToStructuredTruth: false,
        })
      },
      get turns() {
        return turns
      },
    }
    const outcome = await runTurn(
      request({
        utterance: PRICE_QUESTION,
        graph: graph(),
        brain: quoting,
        knowledge: retrieve({ sourceId: 'stale-price', text: 'Room 12 costs 900000 IDR.' }),
        truth: {
          async resolve(): Promise<Readonly<Record<string, unknown>>> {
            await Promise.resolve()
            throw new Error('pricing service unreachable')
          },
        },
      }),
    )
    // Retrieval ran and found the chunk; the brain was never shown it.
    expect(grounding(quoting)).toEqual([])
    // And it reports the same mode, so a provider that does check is told the
    // truth rather than left to infer it from an empty array.
    expect(quoting.turns[0]?.knowledgeMode).toBe('none')
    // So there is nothing to quote, and no citation to lend it authority.
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
    expect(outcome.text).toBe('')
    expect(outcome.citations).toEqual([])
  })

  it('asks an async resolver before running an entity-bearing action', async () => {
    const asked: [string, string][] = []
    const outcome = await runTurn(
      request({
        utterance: 'book Room 12',
        graph: graph([{ type: 'action/set', actions: enabled('booking.create') }]),
        brain: brainFor('booking.create'),
        knowledge: EMPTY_RETRIEVAL,
        resolver: {
          async resolveExists(_tenantId, entityKind, entityId): Promise<boolean> {
            await Promise.resolve()
            asked.push([entityKind, String(entityId)])
            return entityKind === 'slot' && String(entityId) === 'slot_1'
          },
        },
        confirmedActionIds: ['booking.create'],
      }),
    )
    // §9 asked both entity questions — the slot and the nested customer ref —
    // before the gate answered either, which only works if the port's answer is
    // awaited rather than read as a synchronously-returned value.
    expect(asked).toEqual([
      ['slot', 'slot_1'],
      ['customer', 'cust_9'],
    ])
    // The slot exists, so that reference resolved; the customer does not, so the
    // nested refusal fires. The refusal names the path and the id that failed.
    expect(outcome.actions[0]?.policy).toBe('denied')
    expect(outcome.actions[0]?.reason).toContain('customer.customerRef')
    expect(outcome.actions[0]?.reason).toContain('cust_9')
  })
})

describe('structured truth (§17)', () => {
  const PRICE_QUESTION = 'How much is Room 12 per night?'
  const priceTurn = (overrides: Partial<TurnRequest> = {}): TurnRequest =>
    request({ utterance: PRICE_QUESTION, ...overrides })

  it('answers a live question from the live system, not from retrieval', async () => {
    const outcome = await runTurn(
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

  it('reports no gap once the live system has answered, whatever retrieval did', async () => {
    // §17 outranks retrieval, so the gap and the basis have to agree. The port
    // answered `price`, yet retrieval for the same utterance came back empty —
    // which used to be recorded as a knowledge gap on a turn that carries the
    // answer, telling the operator the visitor was left without one. A gap is
    // about the visitor, not about whether a second system also had a match.
    const outcome = await runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: EMPTY_RETRIEVAL,
        truth: deferredTruth({ price: { amountMinor: 1_200_000, currency: 'IDR' } }),
      }),
    )
    expect(outcome.basis).toBe('structured_truth')
    expect(outcome.knowledgeGap).toBe(false)
    // The invariant, stated once: the two fields never contradict each other.
    expect(outcome.knowledgeGap).toBe(outcome.basis === 'none')
  })

  it('does not let retrieval become the basis when the live system is unreachable', async () => {
    // §17's absolute: a price question with no live answer is not answered by a
    // chunk, however confident the chunk looks. A stale price quoted as fact is
    // the failure this clause exists to prevent.
    const outcome = await runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'stale-price', text: 'Room 12 costs 900000 IDR.' }),
      }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
  })

  it('treats a live system that answered nothing as unresolved', async () => {
    const outcome = await runTurn(
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

  it('classifies before retrieving, so retrieval cannot reclassify the question', async () => {
    // The classifier runs first and hands the live subjects onward; retrieval
    // sees the same utterance regardless of what it decided.
    const resolved: unknown[] = []
    const outcome = await runTurn(
      priceTurn({
        graph: graph(),
        brain: probe(),
        knowledge: retrieve({ sourceId: 'k1' }),
        truth: {
          resolve: (
            subjects: readonly StructuredTruthSubject[],
          ): Promise<Readonly<Record<string, unknown>>> => {
            resolved.push([...subjects])
            return Promise.resolve({ price: { amountMinor: 1_200_000, currency: 'IDR' } })
          },
        },
      }),
    )
    expect(resolved).toEqual([['price']])
    expect(outcome.basis).toBe('structured_truth')
    expect(outcome.actions).toHaveLength(0)
  })

  it('answers a retrieval question from retrieval when no live system is needed', async () => {
    const outcome = await runTurn(
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

  it('records a knowledge gap when retrieval came back empty', async () => {
    const outcome = await runTurn(
      request({ graph: graph(), brain: probe(), knowledge: EMPTY_RETRIEVAL }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
  })

  it('survives a retrieval system that throws', async () => {
    // An unreachable knowledge system is a reported gap, not a crashed turn and
    // not a confident guess. The visitor still gets an answer.
    const outcome = await runTurn(
      request({
        graph: graph(),
        brain: probe({ text: 'I could not find that.' }),
        knowledge: {
          retrieve: (): Promise<RetrievalOutcome> => Promise.reject(new Error('store offline')),
        },
      }),
    )
    expect(outcome.basis).toBe('none')
    expect(outcome.knowledgeGap).toBe(true)
    expect(outcome.text).toBe('I could not find that.')
  })
})

describe('the policy gate (§18)', () => {
  it('gives the brain only what the capability, role, and page allow', async () => {
    const brain = probe()
    await runTurn(
      request({
        graph: graph([
          { type: 'action/set', actions: enabled('order.status.read', 'cart.item.add') },
        ]),
        brain,
      }),
    )
    expect(permitted(brain)).toEqual(['order.status.read', 'cart.item.add'])
  })

  it('narrows what the page offers without ever widening it', async () => {
    // `enabled: false` removes an action. The page cannot add one that the
    // capability tier did not already permit.
    const brain = probe()
    const outcome = await runTurn(
      request({
        graph: graph([
          { type: 'action/set', actions: [{ name: 'order.status.read', enabled: false }] },
        ]),
        brain,
      }),
    )
    expect(permitted(brain)).toEqual([])
    expect(outcome.permittedActionIds).toEqual([])
  })

  it('lets a page that says nothing narrow nothing further', async () => {
    // A page that lists an action has offered it, and the answer is "yes" without
    // qualification: `permittedActionIds` is the whole offer, and one entry in it
    // is one entry in the outcome.
    const brain = probe()
    await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain,
      }),
    )
    expect(permitted(brain)).toEqual(['order.status.read'])
  })

  it('denies an above-capability action as above capability, not as a page complaint', async () => {
    // The reference tenant runs at `act`; `payment.initiate` needs `transact`. The
    // page never offered it — the reference page deliberately omits it — and the
    // two facts used to collapse into one denial. Passing the page's list as the
    // gate's client allow-list made this read "not enabled for this client
    // configuration", which is also what an unlisted page action reads, so the
    // denial explained nothing about the tier. Weighed in the right order the
    // answer names the capability, because the capability is the reason there is
    // no page offer to consider.
    const outcome = await runTurn(
      request({
        capability: 'act',
        graph: graph([{ type: 'action/set', actions: enabled('ui.compare', 'booking.create') }]),
        brain: brainFor('payment.initiate'),
      }),
    )
    const payment = outcome.actions[0]
    expect(payment?.policy).toBe('denied')
    expect(payment?.execution).toBe('not_attempted')
    expect(payment?.reason).toBe(
      '"payment.initiate" needs the transact capability; this client is act.',
    )
  })

  it('denies an in-capability action the page does not offer', async () => {
    // §16 at the gate, and the reason is why: the client is Transact, so the tier
    // is not what refused it — the page is. A denial that named the tier here
    // would be a lie about which boundary did the narrowing.
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('ui.compare'),
      }),
    )
    const compare = outcome.actions[0]
    expect(compare?.policy).toBe('denied')
    expect(compare?.execution).toBe('not_attempted')
    expect(compare?.reason).toBe('The current page does not offer "ui.compare".')
  })

  it('treats an action the page disabled as one it does not offer', async () => {
    // Disabled and absent are the same answer from the visitor's side: neither is
    // offered. The executor never hears about it.
    const run = executor()
    const outcome = await runTurn(
      request({
        graph: graph([
          { type: 'action/set', actions: [{ name: 'booking.create', enabled: false }] },
        ]),
        brain: brainFor('booking.create'),
        executor: run,
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]?.reason).toBe('The current page does not offer "booking.create".')
    expect(run.calls).toEqual([])
  })

  it('offers the brain nothing a page offering nothing can carry out', async () => {
    // Fail closed, and the reason is the offer rather than the tier: a page that
    // declared no affordances offers nothing, so an action it never listed cannot
    // be confirmed into existence by a visitor saying yes.
    const run = executor()
    const outcome = await runTurn(
      request({
        brain: brainFor('booking.create'),
        executor: run,
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.permittedActionIds).toEqual([])
    expect(outcome.actions[0]?.reason).toBe('The current page does not offer "booking.create".')
    expect(run.calls).toEqual([])
  })

  it('denies an action the brain invented, without taking the turn down', async () => {
    // A model that names an action has not thereby claimed the tier it needs.
    const outcome = await runTurn(
      request({ graph: graph(), brain: brainFor('booking.cancel_with_refund') }),
    )
    expect(outcome.actions).toHaveLength(1)
    expect(outcome.actions[0]?.policy).toBe('denied')
    expect(outcome.actions[0]?.execution).toBe('not_attempted')
    expect(outcome.actions[0]?.reason).toContain('No action "booking.cancel_with_refund"')
    expect(outcome.handoff?.reason).toBe('capability_exceeded')
  })

  it('holds an unconfirmed L3 action at confirmation_required and does not run it', async () => {
    // §18: capability tier does not override risk rules. A Transact client still
    // needs to confirm an L3 action — while the L0 read beside it runs free.
    const outcome = await runTurn(
      request({
        graph: graph([
          { type: 'action/set', actions: enabled('booking.create', 'order.status.read') },
        ]),
        brain: brainFor('booking.create', 'order.status.read'),
        resolver: CONFIRMING,
      }),
    )
    const booking = outcome.actions.find((action) => action.actionId === 'booking.create')
    expect(booking?.policy).toBe('confirmation_required')
    expect(booking?.execution).toBe('not_attempted')
    expect(booking?.reason).toBe('Confirmation required via user_confirm.')
    expect(booking?.prompt).toContain('booking.create')

    const read = outcome.actions.find((action) => action.actionId === 'order.status.read')
    expect(read?.policy).toBe('allowed')
    expect(read?.execution).toBe('not_attempted')
  })

  it('runs the same action once the visitor confirmed it', async () => {
    const run = executor()
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('booking.create') }]),
        brain: brainFor('booking.create'),
        executor: run,
        confirmedActionIds: ['booking.create'],
        resolver: CONFIRMING,
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('allowed')
    expect(outcome.actions[0]?.execution).toBe('succeeded')
    expect(run.calls).toEqual([
      { action: 'booking.create', inputs: VALID_INPUTS['booking.create'] },
    ])
  })

  it('refuses an L5 admin action unless a human approved it', async () => {
    // "Never autonomous" means the confirmation mode is not enough: a human must
    // have actually approved it, by id, for this session. The capability is
    // Enterprise because `admin.config.update` requires it, so the gate reaches
    // the L5 refusal instead of stopping earlier at the tier.
    const graphWithAdmin = () =>
      graph([{ type: 'action/set', actions: enabled('admin.config.update') }])

    const denied = await runTurn(
      request({
        graph: graphWithAdmin(),
        brain: brainFor('admin.config.update'),
        role: 'admin',
        capability: 'enterprise',
      }),
    )
    expect(denied.actions[0]?.policy).toBe('denied')
    expect(denied.actions[0]?.execution).toBe('not_attempted')
    expect(denied.actions[0]?.reason).toContain('never runs autonomously')

    const run = executor()
    const approved = await runTurn(
      request({
        graph: graphWithAdmin(),
        brain: brainFor('admin.config.update'),
        role: 'admin',
        capability: 'enterprise',
        executor: run,
        confirmedActionIds: ['admin.config.update'],
        humanApprovedActionIds: ['admin.config.update'],
      }),
    )
    expect(approved.actions[0]?.policy).toBe('allowed')
    expect(approved.actions[0]?.execution).toBe('succeeded')
  })

  it('reads the action definition tier for the gate, not the client tier', async () => {
    // The client is Transact; `order.status.read` needs Assist. The permitted
    // set is derived from the client's tier, and the per-action decision from
    // the action's own requirement — so a tier can never quietly widen a check.
    const brain = probe()
    await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        capability: 'assist',
        brain,
      }),
    )
    expect(permitted(brain)).toEqual(['order.status.read'])
  })

  it('keeps a denied action out of the permitted set it offered the brain', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        capability: 'assist',
        brain: brainFor('order.status.read'),
        resolver: CONFIRMING,
      }),
    )
    expect(outcome.permittedActionIds).toEqual(['order.status.read'])
    expect(outcome.actions[0]?.policy).toBe('allowed')
  })
})

describe('action input validation (§9)', () => {
  /** A brain whose inputs are whatever the test wrote, unvalidated in advance. */
  function brainWithInputs(
    actionId: string,
    inputs: Readonly<Record<string, unknown>>,
  ): BrainProvider {
    return {
      providerId: 'probe-brain',
      model: 'reference-model',
      health: { ready: true, reason: null },
      reply() {
        return Promise.resolve({
          text: 'On it.',
          requestedActions: [{ actionId, inputs }],
          citations: [],
          deferToStructuredTruth: false,
        })
      },
    }
  }

  const readingTurn = (brain: BrainProvider): TurnRequest =>
    request({
      graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
      brain,
    })

  it('refuses a missing required field instead of filling it in', async () => {
    // Fail closed: a booking with no slot is a booking that did not happen. The
    // refusal names the field and what it is for, so the model can ask.
    const outcome = await runTurn(readingTurn(brainWithInputs('order.status.read', {})))
    expect(outcome.actions[0]?.policy).toBe('denied')
    // The message names the field it refused and what the field is for, so the
    // model can ask the visitor for it instead of guessing at a value.
    expect(outcome.actions[0]?.reason).toContain('orderReference')
    expect(outcome.actions[0]?.reason).toContain('the order')
  })

  it('refuses a wrong type rather than coercing it', async () => {
    const outcome = await runTurn(
      readingTurn(brainWithInputs('order.status.read', { orderReference: 17 })),
    )
    expect(outcome.actions[0]?.policy).toBe('denied')
    expect(outcome.actions[0]?.reason).toContain('must be a string')
  })

  it('refuses an unknown field rather than dropping it', async () => {
    // Refused twice over: dropping would hide a model reaching for a field the
    // contract does not have, and a tenant id in an input is a §23 accident.
    const outcome = await runTurn(
      readingTurn(
        brainWithInputs('order.status.read', { orderReference: 'ORD-1', tenantId: 'other' }),
      ),
    )
    expect(outcome.actions[0]?.policy).toBe('denied')
    expect(outcome.actions[0]?.reason).toContain('tenantId')
  })

  it('refuses an action that has no registered input contract', async () => {
    // The fail-closed default: a new action is inert until its contract exists,
    // rather than accepting whatever a model happens to send.
    const outcome = await runTurn(
      request({
        graph: graph([
          { type: 'action/set', actions: enabled('order.status.read', 'payment.status.read') },
        ]),
        brain: brainWithInputs('payment.status.read', { paymentReference: 'PAY-1' }),
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('denied')
    expect(outcome.actions[0]?.reason).toContain('No input contract')
  })

  it('refuses an entity id no resolver can confirm', async () => {
    // Existence is a question only the catalog can answer. A shape that parses
    // is not an id that exists, and pretending otherwise is the trap §9 names.
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('order.status.read'),
        resolver: resolverFor({ order: ['ORD-9'] }),
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('denied')
    expect(outcome.actions[0]?.reason).toContain('ORD-1')
    expect(outcome.actions[0]?.reason).toContain('no order matching')
  })

  it('allows an entity id the resolver confirms', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('order.status.read'),
        resolver: resolverFor({ order: ['ORD-1'] }),
        executor: executor(),
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('allowed')
    expect(outcome.actions[0]?.execution).toBe('succeeded')
  })

  it('verifies a nested entity id, not only the top-level ones', async () => {
    // `customer.customerRef` is a reference to a real customer one level down.
    // Checking the parent and not the child would let a booking be created
    // against a customer who does not exist.
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('booking.create') }]),
        brain: brainFor('booking.create'),
        resolver: resolverFor({ slot: ['slot_1'], customer: ['cust_other'] }),
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('denied')
    // The refusal names the nested path and the id that failed to resolve, so the
    // model knows which of the two it may retry.
    expect(outcome.actions[0]?.reason).toContain('customer.customerRef')
    expect(outcome.actions[0]?.reason).toContain('cust_9')
  })

  it('leaves an optional nested field out rather than inventing it', async () => {
    const run = executor()
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('booking.create') }]),
        brain: brainWithInputs('booking.create', {
          slotId: 'slot_1',
          customer: { customerRef: 'cust_9' },
        }),
        resolver: resolverFor({ slot: ['slot_1'], customer: ['cust_9'] }),
        executor: run,
        confirmedActionIds: ['booking.create'],
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('allowed')
    expect(outcome.actions[0]?.execution).toBe('succeeded')
    expect(run.calls[0]?.inputs).toEqual({
      slotId: 'slot_1',
      customer: { customerRef: 'cust_9' },
    })
  })

  it('reports a failed execution separately from a denied one', async () => {
    // §8's separation: the gate allowed it, the executor tried, the store was
    // down. An operator must be able to tell that from a permission problem.
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('order.status.read'),
        resolver: CONFIRMING,
        executor: {
          executorId: 'broken',
          execute() {
            return Promise.reject(new Error('store offline'))
          },
        },
      }),
    )
    expect(outcome.actions[0]?.policy).toBe('allowed')
    expect(outcome.actions[0]?.execution).toBe('failed')
    expect(outcome.actions[0]?.errorCode).toBe('executor_threw')
    expect(outcome.actions[0]?.retryable).toBe(true)
    expect(outcome.actions[0]?.reason).toBe('store offline')
  })
})

describe('generative UI (§25)', () => {
  const cta = (actionId: string): { kind: string; props: Record<string, unknown> } => ({
    kind: 'cta',
    props: { label: 'Book', actionId },
  })

  it('keeps a component the registry accepts', async () => {
    const outcome = await runTurn(
      request({
        graph: graph(),
        brain: brainWithComponents([
          {
            kind: 'recommendation_list',
            props: {
              items: [
                { entityId: 'room-12', entityName: 'Room 12', reason: 'closest', sourceId: null },
              ],
            },
          },
        ]),
      }),
    )
    expect(outcome.components).toHaveLength(1)
    expect(outcome.components[0]?.kind).toBe('recommendation_list')
    expect(outcome.rejectedComponents).toEqual([])
  })

  it('rejects an invented kind and reports why instead of rendering it', async () => {
    // Model output selects from a registry. It does not execute arbitrary
    // client-side code, so an unknown kind never becomes a component.
    const outcome = await runTurn(
      request({
        graph: graph(),
        brain: brainWithComponents([{ kind: 'arbitrary_widget', props: {} }]),
      }),
    )
    expect(outcome.components).toEqual([])
    expect(outcome.rejectedComponents).toHaveLength(1)
    expect(outcome.rejectedComponents[0]).toContain('arbitrary_widget')
  })

  it('drops a CTA whose action the gate did not permit, keeping its siblings', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainWithComponents([
          cta('admin.config.update'),
          {
            kind: 'faq_source_card',
            props: { sourceId: 's1', sourceTitle: 'Policy', excerpt: 'Check-in is 14:00.' },
          },
        ]),
      }),
    )
    // The card runs nothing, so the gate does not touch it.
    expect(outcome.components.map((component) => component.kind)).toEqual(['faq_source_card'])
  })
})

describe('handoff and events (§26, §27)', () => {
  it('hands over with the story the visitor should not have to repeat', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([
          { type: 'entities/select', entityId: 'room-12' },
          { type: 'session/authenticated', role: 'guest', customerRef: 'cust_9' },
          { type: 'error/recorded', code: 'booking_slot_unavailable', occurredAt: OCCURRED_AT },
        ]),
        brain: brainFor('order.status.read'),
      }),
    )
    expect(outcome.handoff?.summary).toContain('room-12')
    expect(outcome.handoff?.errors).toEqual([
      {
        code: 'booking_slot_unavailable',
        message: `Recorded at ${OCCURRED_AT}.`,
      },
    ])
  })

  it('escalates after repeated failure without being asked', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([
          { type: 'error/recorded', code: 'booking_slot_unavailable', occurredAt: OCCURRED_AT },
          { type: 'error/recorded', code: 'payment_declined', occurredAt: OCCURRED_AT },
          { type: 'error/recorded', code: 'checkout_timeout', occurredAt: OCCURRED_AT },
        ]),
        brain: probe(),
      }),
    )
    expect(outcome.handoff?.reason).toBe('repeated_failure')
  })

  it('separates a denied action from a failed execution (§8)', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('admin.config.update'),
        utterance: 'Which rooms are near the beach?',
      }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toContain('meaningful_question_answered')
    // An action the gate refused is `action_denied`. It is not `tool_failure`,
    // which is reserved for a tool the platform depends on breaking, and not
    // `action_execution_failed`, which is an attempt that did not work out.
    expect(names).toContain('action_denied')
    expect(names).not.toContain('action_execution_failed')
    expect(names).not.toContain('tool_failure')
    expect(names).not.toContain('knowledge_gap')
    expect(outcome.events.find((event) => event.name === 'action_denied')?.subjectId).toBe(
      'admin.config.update',
    )
  })

  it('records a confirmation hold as its own event (§8)', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('booking.create') }]),
        brain: brainFor('booking.create'),
      }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toContain('action_confirmation_required')
    expect(names).not.toContain('action_denied')
    expect(names).not.toContain('action_execution_succeeded')
  })

  it('records a confirmed side effect as its own event (§8)', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('order.status.read'),
        resolver: CONFIRMING,
        executor: executor(),
      }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toContain('action_execution_succeeded')
    expect(names).not.toContain('action_denied')
  })

  it('records an attempt that failed as its own event (§8)', async () => {
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('order.status.read'),
        resolver: CONFIRMING,
        executor: {
          executorId: 'broken',
          execute() {
            return Promise.resolve({
              status: 'failed',
              errorCode: 'store_offline',
              retryable: true,
              message: 'Store offline.',
            })
          },
        },
      }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toContain('action_execution_failed')
    expect(names).not.toContain('action_denied')
    expect(outcome.events.find((event) => event.name === 'action_execution_failed')?.note).toBe(
      'store_offline',
    )
  })

  it('emits nothing for an allowed action that was never attempted', async () => {
    // `allowed` with no executor means no side effect happened. Emitting a
    // success event here is how an assistant comes to report bookings it never
    // made.
    const outcome = await runTurn(
      request({
        graph: graph([{ type: 'action/set', actions: enabled('order.status.read') }]),
        brain: brainFor('order.status.read'),
        resolver: CONFIRMING,
      }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).not.toContain('action_execution_succeeded')
    expect(names).not.toContain('action_execution_failed')
    expect(names).not.toContain('action_denied')
  })

  it('emits a knowledge gap and stays quiet when there is no answer', async () => {
    const outcome = await runTurn(
      request({ graph: graph(), brain: probe({ text: '' }), knowledge: EMPTY_RETRIEVAL }),
    )
    const names = outcome.events.map((event) => event.name)
    expect(names).toEqual(['knowledge_gap'])
  })
})
