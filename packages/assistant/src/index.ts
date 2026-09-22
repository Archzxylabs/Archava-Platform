/**
 * The assistant: one deterministic turn pipeline plus the pieces it composes.
 *
 * The public surface is deliberately thin. A caller supplies a turn request
 * (PRD §16 context graph, §17 knowledge ports, §18 policy gate, §21 brain) and
 * gets back an outcome (grounded answer, gated actions, validated §25
 * components, §26 handoff payload, §27 events). Everything that decides what
 * may cross a boundary is here, so nothing downstream has to re-decide it.
 */

export {
  runTurn,
  projectContextGraph,
  type AnswerBasis,
  type GatedAction,
  type KnowledgePort,
  type StructuredTruthPort,
  type TurnOutcome,
  type TurnRequest,
} from './turn.js'

export {
  GENERATIVE_COMPONENT_KINDS,
  GENERATIVE_PROP_SCHEMAS,
  TRANSACTION_STAGES,
  GenerativeUIError,
  buildComponent,
  buildComponents,
  filterComponentsByAllowedActions,
  type GenerativeComponent,
  type GenerativeComponentKind,
  type GenerativeProps,
  type TransactionStage,
} from './generative-ui.js'

export {
  ANALYTICS_EVENTS,
  AnalyticsError,
  KNOWLEDGE_GAP_EVENT,
  MEANINGFUL_ANSWER_EVENT,
  PRESENCE_FALLBACK_EVENT,
  TOOL_FAILURE_EVENT,
  buildEvent,
  type AnalyticsEvent,
  type AnalyticsEventBase,
  type AnalyticsEventDetails,
  type AnalyticsEventName,
} from './analytics.js'

export {
  HANDOFF_REASONS,
  HandoffError,
  buildHandoffContext,
  summarizeForHandoff,
  type HandoffAttemptedAction,
  type HandoffContext,
  type HandoffErrorRecord,
  type HandoffReason,
} from './handoff.js'
