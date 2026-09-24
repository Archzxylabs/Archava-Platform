/**
 * The joint between a page and the turn pipeline.
 *
 * This module is the only place the browser knows the shape of its tenant, and
 * it is the only place the pipeline knows a page exists. Both directions are
 * deliberate: a page hands over an utterance and a graph, and receives an
 * outcome that was already decided — the same outcome the studio, the CLI, and
 * the tests run against.
 *
 * The tenant is `@archava/reference`'s, not a second copy of it. The reference
 * package exists so that one config can be exercised by every entry point, and
 * a slice that carried its own literal would drift from the package the tests
 * already pin. When a tenant is configured through the studio, the same `ask`
 * runs with that tenant's config in place of this one — nothing else here
 * changes, which is the property that makes the slice worth running.
 *
 * What is built once, and why once: the knowledge store holds ingested
 * documents, and rebuilding it per turn would make a page feel slow and a
 * tenant's corpus look stateful. The store is built from the parsed config and
 * then read, never written, per turn.
 */
import { actionPolicy } from '@archava/acl'
import { ScriptedBrain } from '@archava/adapters'
import {
  runTurn,
  type ActionExecutor,
  type EntityResolver,
  type TurnOutcome,
} from '@archava/assistant'
import type { ClientConfig, Entity } from '@archava/config'
import {
  assertTenant,
  foldContextEvents,
  seedContextGraph,
  type ContextEvent,
  type ContextGraph,
} from '@archava/core'
import type { RetrievalContextRequest, RetrievalOutcome } from '@archava/knowledge'
import { retrieveContext } from '@archava/knowledge'
import {
  REFERENCE_CURRENCY,
  REFERENCE_TENANT_ID,
  ReferenceBrain,
  buildKnowledgeStore,
  referenceConfig,
  referenceTruth,
} from '@archava/reference'

/** Everything a page needs to run a turn, and nothing that decides one. */
export interface Slice {
  /** The tenant this slice runs as (§16: a page has one scope). */
  readonly clientId: string
  /** The parsed config, so a host can theme from the same source the turn used. */
  readonly config: ClientConfig
  /** The tenant's bookable entities, for a page that lists them. */
  readonly units: readonly Entity[]
  /** The money the truth port quotes in (§17: a price is meaningless without it). */
  readonly currency: string
  /** Run one turn. Never throws for a refused action; a refusal is a decision. */
  ask(request: SliceRequest): Promise<TurnOutcome>
  /** Fold the page's events into the graph the pipeline reads. */
  graph(events: readonly ContextEvent[], route?: string): ContextGraph
  /** Seed an empty graph on a route, before the page has observed anything. */
  seed(route?: string): ContextGraph
}

/** What a page supplies per turn. A turn never reads a clock it was not given. */
export interface SliceRequest {
  /** The visitor's words. */
  readonly utterance: string
  /** The page as the SDK recorded it, already masked (§16). */
  readonly graph: ContextGraph
  /** ISO timestamp of the turn, supplied by the page. */
  readonly occurredAt: string
  /** The session the turn belongs to. */
  readonly sessionId: string
  /** Who runs an action the gate allows. Absent keeps an allowed action unrun. */
  readonly executor?: ActionExecutor
  /** Actions the visitor confirmed on-screen this turn (§18). */
  readonly confirmedActionIds?: readonly string[]
  /**
   * Actions the visitor declined this session (§18).
   *
   * Kept for the session rather than the turn, and held here rather than pushed
   * into the gate as a memo of the last asked set: the gate answers about the
   * action, the page knows what the visitor said, and a decline needs to outlive
   * the turn that received it.
   */
  readonly declinedActionIds?: readonly string[]
  /** Actions an operator approved for this session (§18). */
  readonly humanApprovedActionIds?: readonly string[]
  /**
   * Who answers "does this id exist" for §9 validation. The page supplies one,
   * because a page action names something the *page* is showing and only the
   * page knows that. Absent means an id-bearing action cannot execute — which is
   * the answer §18 wants when nobody can vouch for the id.
   */
  readonly resolver?: EntityResolver
  /** True when the visitor asked for a person (§26). */
  readonly handoffRequested?: boolean
  /** How many chunks retrieval may return. Absent lets the caller's plan decide. */
  readonly retrievalLimit?: number
}

/**
 * Wire the slice against a tenant config.
 *
 * `config` defaults to the reference tenant so the page runs with no setup, and
 * the parameter exists so the studio can hand over a configured tenant instead.
 * The tenant id is read from the config rather than passed separately: a page
 * whose scope and whose config disagree has no right answer, and passing both
 * would make that disagreement representable.
 */
export function createSlice(config: ClientConfig = referenceConfig): Slice {
  const store = buildKnowledgeStore(config)

  const knowledge = {
    // Promise-returning because the port's contract is a promise. The reference
    // store is in memory, so the work completes immediately — but the *type* is
    // what a hosted index would have to implement, and a caller that could tell
    // the difference would be a caller that could skip the `await`.
    retrieve: (request: RetrievalContextRequest): Promise<RetrievalOutcome> =>
      Promise.resolve(retrieveContext(request, store)),
  }

  // The brain is wrapped, and the wrapper is what makes the §18 path reachable
  // at all: `ScriptedBrain` answers and never asks, so without it no turn on
  // this page would ever carry an action request to the gate.
  const brain = new ReferenceBrain(
    new ScriptedBrain({
      providerId: 'archava-reference-brain',
      answers: {
        breakfast: 'Breakfast is served from 6am to 10am in the valley pavilion.',
        wifi: 'The whole property is covered by wifi, and the password is on your keycard sleeve.',
        'check in': 'Check-in opens at 2pm and check-out closes at 12 noon.',
        pool: 'The infinity pool is open from 7am to 9pm, and towels are at the deck bar.',
      },
      fallback:
        'I can only answer from what this property has published, and I do not have that. A host can help at the front desk.',
    }),
    'archava-reference-brain',
  )

  // The acl package's own default gate, not a second one. `ActionPolicy` holds
  // no mutable state — only the registry it reads — so building one here would
  // produce two objects that answer the same question, and a shared default
  // with no consumer is a shared default nobody has checked.
  const policy = actionPolicy

  return {
    clientId: config.tenantId,
    config,
    units: config.entities,
    currency: REFERENCE_CURRENCY,

    ask: async (request: SliceRequest): Promise<TurnOutcome> => {
      // A turn against a graph from another tenant is a scope breach, not a
      // quiet empty answer. The assertion is here as well as inside `runTurn`
      // so the page's own bug surfaces at the page, before a turn is produced.
      assertTenant(request.graph, config.tenantId)
      return runTurn({
        tenantId: config.tenantId,
        sessionId: request.sessionId,
        utterance: request.utterance,
        graph: request.graph,
        occurredAt: request.occurredAt,
        brain,
        policy,
        knowledge,
        truth: referenceTruth,
        // Absent on purpose: an allowed action stays `not_attempted` until a
        // real system is behind it. The page shows the decision, not a lie (§18).
        capability: config.capability,
        role: 'archava_assistant',
        ...(request.executor === undefined ? {} : { executor: request.executor }),
        ...(request.confirmedActionIds === undefined
          ? {}
          : { confirmedActionIds: request.confirmedActionIds }),
        ...(request.declinedActionIds === undefined
          ? {}
          : { declinedActionIds: request.declinedActionIds }),
        ...(request.humanApprovedActionIds === undefined
          ? {}
          : { humanApprovedActionIds: request.humanApprovedActionIds }),
        ...(request.handoffRequested === undefined
          ? {}
          : { handoffRequested: request.handoffRequested }),
        ...(request.resolver === undefined ? {} : { resolver: request.resolver }),
        ...(request.retrievalLimit === undefined ? {} : { retrievalLimit: request.retrievalLimit }),
      })
    },

    graph: (events: readonly ContextEvent[], route = '/'): ContextGraph =>
      foldContextEvents(seedContextGraph(config, route), events),

    seed: (route = '/'): ContextGraph => seedContextGraph(config, route),
  }
}

/** The tenant the runnable slice runs as, for a page that needs the id alone. */
export const SLICE_CLIENT_ID = REFERENCE_TENANT_ID
