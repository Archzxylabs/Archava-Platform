/**
 * The deterministic turn pipeline (PRD §16–§21, §23, §25–§27).
 *
 * One function, `runTurn`, walks a single visitor turn end to end in a fixed
 * order. The order is the specification, so it is worth stating plainly:
 *
 *   1. **Tenant scope** (PRD §23). The graph is asserted against the requested
 *      tenant before anything reads it. A cross-tenant graph throws; it never
 *      quietly answers from the wrong tenant's page.
 *   2. **Structured truth** (PRD §17). The utterance is classified *before*
 *      retrieval, because "how much is this" must be answered from the live
 *      authoritative system rather than a chunk that was true last Tuesday.
 *   3. **The masking boundary** (PRD §16). The graph is projected to ids,
 *      labels, counts, and flags, then masked. Not the other way around: the
 *      projection is why no form value can reach a model, and the masker is why
 *      a name that turns out to be sensitive is still withheld.
 *   4. **The policy gate** (PRD §18). Available actions are computed once, and
 *      every action the brain asks for is re-evaluated against that gate. Page
 *      context appears here as a *narrowing* input and nothing else.
 *   5. **The brain**. A pure function of (turn, grounding, permitted actions),
 *      so a turn is reproducible given the same inputs.
 *   6. **Validated generative UI** (PRD §25). Whatever the brain selected is
 *      unvalidated input; what survives the registry's prop schemas is what the
 *      client draws. Nothing here is ever evaluated as code.
 *   7. **Handoff and analytics** (PRD §26, §27).
 *
 * Nothing in this module touches the network or the wall clock. Both arrive as
 * arguments, because a turn that reads either cannot be replayed — and a replay
 * is what makes a bug report answerable.
 */

import type { ActionDefinition, ActionPolicy, PolicyResult, RoleName } from '@archava/acl'
import { maskSensitiveFields, resolveMaskRules } from '@archava/acl'
import type { CapabilityTierName } from '@archava/config'
import type { ContextGraph } from '@archava/core'
import { assertTenant } from '@archava/core'
import type { BrainProvider, BrainReply } from '@archava/adapters'
import type {
  KnowledgeClassification,
  RetrievalContextRequest,
  RetrievalOutcome,
  StructuredTruthSubject,
} from '@archava/knowledge'
import { classifyKnowledgeNeed } from '@archava/knowledge'
import {
  buildComponents,
  filterComponentsByAllowedActions,
  type GenerativeComponent,
} from './generative-ui.js'
import {
  buildEvent,
  KNOWLEDGE_GAP_EVENT,
  MEANINGFUL_ANSWER_EVENT,
  TOOL_FAILURE_EVENT,
  type AnalyticsEvent,
} from './analytics.js'
import {
  buildHandoffContext,
  type HandoffContext,
  type HandoffReason,
} from './handoff.js'

/** Retrieval, narrowed to the one call the pipeline makes. */
export interface KnowledgePort {
  readonly retrieve: (request: RetrievalContextRequest) => RetrievalOutcome
}

/**
 * The live authoritative systems (PRD §17).
 *
 * Deliberately absent by default: an assistant that cannot reach a price or a
 * stock system must say so, not guess. `runTurn` records a knowledge gap rather
 * than answering from retrieval when this port is missing.
 */
export interface StructuredTruthPort {
  readonly resolve: (
    subjects: readonly StructuredTruthSubject[],
  ) => Readonly<Record<string, unknown>>
}

export interface TurnRequest {
  readonly tenantId: string
  readonly sessionId: string
  readonly utterance: string
  /** Page context as the SDK recorded it (PRD §16). */
  readonly graph: ContextGraph
  /** ISO timestamp supplied by the caller. A turn never reads the clock. */
  readonly occurredAt: string
  readonly brain: BrainProvider
  readonly policy: ActionPolicy
  readonly knowledge: KnowledgePort
  readonly truth?: StructuredTruthPort
  /** The session's capability tier, not the action's (PRD §18). */
  readonly capability: CapabilityTierName
  readonly role: RoleName
  /** Extra field names the tenant considers sensitive, on top of the action's own. */
  readonly clientSensitiveFields?: readonly string[]
  /** Actions the visitor already confirmed on-screen this turn. */
  readonly confirmedActionIds?: readonly string[]
  /** Actions a human operator approved for this session. */
  readonly humanApprovedActionIds?: readonly string[]
  /** True when the visitor asked for a person (PRD §26). */
  readonly handoffRequested?: boolean
  readonly retrievalLimit?: number
}

/** One action request, after the gate has had its say. */
export interface GatedAction {
  readonly actionId: string
  readonly decision: PolicyResult['decision']
  /** Present for `denied` and `confirmation_required`. */
  readonly reason?: string
  /** The confirmation prompt, when the gate wants one. */
  readonly prompt?: string
  /** True when the action actually ran. */
  readonly ran: boolean
  readonly inputs: Readonly<Record<string, unknown>>
}

export type AnswerBasis = 'structured_truth' | 'retrieval' | 'none'

export interface TurnOutcome {
  readonly tenantId: string
  readonly sessionId: string
  readonly occurredAt: string
  readonly basis: AnswerBasis
  readonly text: string
  /** Live values, when the turn needed them and the port produced them. */
  readonly structuredTruth: Readonly<Record<string, unknown>>
  readonly citations: readonly { readonly sourceId: string; readonly sourceTitle: string }[]
  readonly components: readonly GenerativeComponent[]
  /** Why each rejected model selection was rejected; never silently dropped. */
  readonly rejectedComponents: readonly string[]
  readonly permittedActionIds: readonly string[]
  readonly actions: readonly GatedAction[]
  /** §16 masking notes for everything withheld from the provider. */
  readonly notices: readonly string[]
  /** True when the turn needed knowledge neither live data nor the corpus covered. */
  readonly knowledgeGap: boolean
  readonly handoff: HandoffContext | null
  readonly events: readonly AnalyticsEvent[]
}

const NOTHING: Readonly<Record<string, unknown>> = {}

/**
 * Render an optional section as a plain object or `null`.
 *
 * `null` rather than omission: an absent cart is a fact worth stating ("there is
 * no cart"), and an absent key would force every consumer to distinguish
 * "missing" from "present but empty".
 */
function section<T>(
  value: T | undefined,
  present: (value: T) => Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  return value === undefined ? null : present(value)
}

/**
 * Project the graph to what a model may see (PRD §16).
 *
 * This is the reason the masker is a second line of defence rather than the
 * only one: the projection emits ids, labels, counts, and flags — never a form
 * value, because the graph holds field *names* and not field values. A value
 * cannot be projected because it was never carried.
 */
export function projectContextGraph(
  graph: ContextGraph,
): Readonly<Record<string, unknown>> {
  const { page, session } = graph
  return {
    route: page.route,
    pageKind: page.kind,
    section: page.section ?? null,
    locale: page.locale,
    entities: graph.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      entityKind: entity.kind,
    })),
    comparison: section(graph.comparison, (comparison) => ({
      entityIds: comparison.entityIds,
      metric: comparison.metric ?? null,
    })),
    form: section(graph.form, (form) => ({
      id: form.id,
      step: form.step ?? null,
      completedFields: form.completedFields,
      pendingFields: form.pendingFields,
      withheldFields: form.maskedFields,
    })),
    cart: section(graph.cart, (cart) => ({
      currency: cart.currency ?? null,
      lineCount: cart.lineCount,
      subtotal: cart.subtotal ?? null,
    })),
    checkout: section(graph.checkout, (checkout) => ({
      step: checkout.step,
      index: checkout.index ?? null,
      total: checkout.total ?? null,
    })),
    errors: graph.errors.map((error) => ({ code: error.code, occurredAt: error.occurredAt })),
    availableActions: graph.availableActions.map((action) => ({
      name: action.name,
      enabled: action.enabled,
    })),
    activePanel: graph.activePanel ?? null,
    session: {
      authenticated: session.authenticated,
      role: session.role ?? null,
      customerRef: session.customerRef ?? null,
    },
  }
}

/**
 * Apply §16 at the boundary: mask the projected context.
 *
 * The rules combine what the enabled actions declare as sensitive with whatever
 * the tenant adds. Given the projection above this is belt-and-braces — it is
 * what catches a host that later learns a field it has been echoing is
 * sensitive, without that host having to remember to stop echoing it.
 */
function maskAtBoundary(
  request: TurnRequest,
): { readonly value: Readonly<Record<string, unknown>>; readonly notices: readonly string[] } {
  const declared = enabledPageActions(request.graph).flatMap(
    (actionId) => definitionFor(actionId, request.policy)?.sensitiveFields ?? [],
  )
  const rules = resolveMaskRules(declared, request.clientSensitiveFields ?? [])
  const masked = maskSensitiveFields(projectContextGraph(request.graph), { rules })

  return { value: masked.value as Readonly<Record<string, unknown>>, notices: masked.notices }
}

/** The enabled page actions, as identities the policy gate understands. */
function enabledPageActions(graph: ContextGraph): readonly string[] {
  return graph.availableActions.filter((action) => action.enabled).map((action) => action.name)
}

/**
 * Ask the policy gate which actions this session may be shown (PRD §18).
 *
 * The client's capability tier narrows the set; the role narrows it further.
 * Neither widens it, which is the whole point.
 */
function permittedActions(request: TurnRequest): readonly string[] {
  return request.policy.availableActionIds({
    capability: request.capability,
    role: request.role,
    enabledActionIds: enabledPageActions(request.graph),
    humanApproved: request.humanApprovedActionIds !== undefined,
  })
}

/**
 * Read one action request through the gate.
 *
 * The capability comes from the registered action definition, never from the
 * brain's output: a model that names an action has not thereby claimed the tier
 * it requires. An unregistered id is a denial, not a crash — the turn survives
 * and the denial is reported.
 */
function gateAction(
  actionId: string,
  inputs: Readonly<Record<string, unknown>>,
  request: TurnRequest,
): GatedAction {
  const required = capabilityFor(actionId, request.policy)
  if (required === null) {
    return {
      actionId,
      decision: 'denied',
      reason: `No action "${actionId}" is registered.`,
      ran: false,
      inputs,
    }
  }

  const result = request.policy.evaluate({
    actionId,
    capability: required,
    role: request.role,
    availableOnPage: pageAvailability(actionId, request.graph),
    confirmed: request.confirmedActionIds?.includes(actionId) === true,
    humanApproved: request.humanApprovedActionIds?.includes(actionId) === true,
    enabledActionIds: enabledPageActions(request.graph),
  })

  return toGatedAction(actionId, inputs, result)
}

/** The tier a registered action requires, or `null` when it is not registered. */
function capabilityFor(actionId: string, policy: ActionPolicy): CapabilityTierName | null {
  const definition = definitionFor(actionId, policy)
  return definition === null ? null : definition.requiresCapability
}

/**
 * A registered action definition, or `null` when the id is not registered.
 *
 * An unregistered id is a denial and not a crash: `describe` throws for an
 * unknown action, and turning that into `null` lets the gate answer "no such
 * action" in the outcome rather than taking the turn down.
 */
function definitionFor(actionId: string, policy: ActionPolicy): ActionDefinition | null {
  try {
    return policy.describe(actionId)
  } catch {
    return null
  }
}

/**
 * What the page said about an action.
 *
 * `false` only when the page explicitly declared it unavailable; `undefined`
 * when the page said nothing. Neither can widen anything: the client allow-list
 * (`enabledActionIds`) has already failed closed on every action the page does
 * not enable, so a silent page is a denial before this is ever consulted. It
 * stays the direct §18 narrowing signal for a caller that invokes the gate
 * without a client allow-list.
 */
function pageAvailability(actionId: string, graph: ContextGraph): boolean | undefined {
  const entry = graph.availableActions.find((action) => action.name === actionId)
  return entry?.enabled
}

/**
 * Translate one gate decision into the outcome's action record.
 *
 * A confirmation is a `ran: false`: the gate has not said yes, it has said "not
 * yet", and the distinction is what keeps an unconfirmed action out of the
 * audit trail as though it had executed.
 */
function toGatedAction(
  actionId: string,
  inputs: Readonly<Record<string, unknown>>,
  result: PolicyResult,
): GatedAction {
  if (result.decision === 'allow') {
    return { actionId, decision: 'allow', ran: true, inputs }
  }
  if (result.decision === 'confirmation_required') {
    return {
      actionId,
      decision: result.decision,
      // The mode names *who* must confirm, which is the useful part to record.
      reason: `Confirmation required via ${result.mode}.`,
      prompt: result.prompt,
      ran: false,
      inputs,
    }
  }
  return { actionId, decision: 'denied', reason: result.message, ran: false, inputs }
}

function gateActions(reply: BrainReply, request: TurnRequest): readonly GatedAction[] {
  return reply.requestedActions.map((action) =>
    gateAction(action.actionId, action.inputs, request),
  )
}

/** Validate the brain's component selections against the registry (PRD §25). */
function validatedComponents(
  reply: BrainReply,
  permittedActionIds: readonly string[],
): { readonly components: readonly GenerativeComponent[]; readonly rejected: readonly string[] } {
  const built = buildComponents(reply.components ?? [])
  return {
    components: filterComponentsByAllowedActions(built.components, permittedActionIds),
    rejected: built.rejected,
  }
}

function resolveTruth(
  classification: KnowledgeClassification,
  request: TurnRequest,
): { readonly values: Readonly<Record<string, unknown>>; readonly resolved: boolean } {
  if (classification.need !== 'structured_truth' || request.truth === undefined) {
    return { values: NOTHING, resolved: false }
  }
  const values = request.truth.resolve(classification.subjects)
  // A port that came back empty for the subjects it was asked about has not
  // answered. Reporting that record as authoritative truth would be §17's guess
  // wearing a uniform, so it counts as unresolved and the turn records a gap.
  return { values, resolved: Object.keys(values).length > 0 }
}

/**
 * What the turn's answer rests on (PRD §17).
 *
 * Retrieval is never the basis of a structured-truth answer. When the live
 * system did not answer — no port configured, or a port that returned nothing —
 * the basis is `none`: the caller is told nothing authoritative backed the
 * turn, which is the same thing `knowledgeGap` says.
 */
function basisOf(
  need: KnowledgeClassification['need'],
  truthResolved: boolean,
  retrieved: boolean,
): AnswerBasis {
  if (truthResolved) {
    return 'structured_truth'
  }
  if (need === 'structured_truth') {
    return 'none'
  }
  return retrieved ? 'retrieval' : 'none'
}

/**
 * Retrieve the tenant's own content, or record why it could not be.
 *
 * A retrieval failure is a knowledge gap the operator should see (§27
 * `knowledge_gap`), not a silent empty answer — the visitor is told nothing was
 * found rather than being handed a confident guess.
 */
function retrieve(request: TurnRequest): { readonly outcome: RetrievalOutcome | null; readonly failed: boolean } {
  const query: RetrievalContextRequest = {
    question: request.utterance,
    tenantId: request.tenantId,
    ...(request.retrievalLimit === undefined ? {} : { limit: request.retrievalLimit }),
  }
  try {
    const outcome = request.knowledge.retrieve(query)
    return { outcome, failed: outcome.context.length === 0 }
  } catch {
    return { outcome: null, failed: true }
  }
}

/**
 * Compose the handoff payload, when the turn warrants one.
 *
 * The summary is mechanical on purpose: what was tried, what broke, where the
 * visitor is. It does not characterise their mood — see `handoff.ts`.
 */
function buildHandoff(
  request: TurnRequest,
  actions: readonly GatedAction[],
): HandoffContext | null {
  const reason = handoffReason(request, actions)
  if (reason === null) {
    return null
  }

  const graph = request.graph
  const attempted = actions.map((action) => ({
    actionId: action.actionId,
    outcome: action.ran ? ('allowed' as const) : ('denied' as const),
    ...(action.reason === undefined ? {} : { detail: action.reason }),
  }))

  return buildHandoffContext({
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    reason,
    route: graph.page.route,
    locale: graph.page.locale,
    // Shared only when the session is authenticated and carries a reference.
    // An anonymous visitor has no identity to hand over, and inventing one is
    // worse than leaving the field absent (§26).
    ...(graph.session.authenticated && graph.session.customerRef !== undefined
      ? { customerRef: graph.session.customerRef }
      : {}),
    attemptedActions: attempted,
    errors: graph.errors.map((error) => ({
      code: error.code,
      message: `Recorded at ${error.occurredAt}.`,
    })),
    summary: `Visitor at ${graph.page.route} (${graph.page.kind}) after ${attempted.length} attempted action(s); ${graph.errors.length} recorded error(s).`,
  })
}

/** Why this turn escalates, or `null` when it does not. */
function handoffReason(request: TurnRequest, actions: readonly GatedAction[]): HandoffReason | null {
  if (request.handoffRequested === true) {
    return 'visitor_requested'
  }
  if (actions.some((action) => action.decision === 'denied')) {
    return 'capability_exceeded'
  }
  if (actions.length >= REPEATED_FAILURE_THRESHOLD) {
    return 'repeated_failure'
  }
  return null
}

const REPEATED_FAILURE_THRESHOLD = 3

/** Per-turn §27 events. Session-scoped events belong to whoever owns the session. */
function turnEvents(
  request: TurnRequest,
  outcome: Omit<TurnOutcome, 'events'>,
): readonly AnalyticsEvent[] {
  const envelope = {
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    occurredAt: request.occurredAt,
  }
  const events: AnalyticsEvent[] = []

  if (outcome.text.length > 0 || outcome.components.length > 0) {
    events.push(
      buildEvent({
        ...envelope,
        name: MEANINGFUL_ANSWER_EVENT,
        outcome: outcome.basis,
      }),
    )
  }
  if (outcome.knowledgeGap) {
    events.push(buildEvent({ ...envelope, name: KNOWLEDGE_GAP_EVENT }))
  }
  if (outcome.actions.some((action) => action.decision === 'denied')) {
    events.push(
      buildEvent({
        ...envelope,
        name: TOOL_FAILURE_EVENT,
        note: outcome.actions.map((action) => action.actionId).join(','),
      }),
    )
  }

  return events
}

/**
 * Run one turn.
 *
 * Throws only on a §23 tenant-scope violation, which is a bug and not a
 * condition to recover from. Everything else — an unreachable knowledge system,
 * a brain that invents a component kind, an action the page no longer offers —
 * is reported in the outcome so the visitor still gets an answer.
 */
export function runTurn(request: TurnRequest): TurnOutcome {
  const graph = assertTenant(request.graph, request.tenantId)
  const classification = classifyKnowledgeNeed(request.utterance)
  const truth = resolveTruth(classification, request)
  const retrieval = retrieve(request)

  const permitted = permittedActions(request)
  const masked = maskAtBoundary(request)
  const grounded = retrieval.outcome?.context ?? []

  const reply = request.brain.reply({
    tenantId: request.tenantId,
    utterance: request.utterance,
    locale: graph.page.locale,
    context: masked.value,
    grounding: grounded,
    permittedActionIds: permitted,
  })

  const actions = gateActions(reply, request)
  const { components, rejected } = validatedComponents(reply, permitted)

  const knowledgeGap =
    retrieval.failed || (classification.need === 'structured_truth' && !truth.resolved)

  const outcome: Omit<TurnOutcome, 'events'> = {
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    occurredAt: request.occurredAt,
    basis: basisOf(classification.need, truth.resolved, grounded.length > 0),
    text: reply.text,
    structuredTruth: truth.values,
    citations: reply.citations,
    components,
    rejectedComponents: rejected,
    permittedActionIds: permitted,
    actions,
    notices: masked.notices,
    knowledgeGap,
    handoff: buildHandoff(request, actions),
  }

  return { ...outcome, events: turnEvents(request, outcome) }
}
