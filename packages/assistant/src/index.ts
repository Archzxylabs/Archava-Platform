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
  ACTION_CONFIRMATION_REQUIRED_EVENT,
  ACTION_DENIED_EVENT,
  ACTION_EXECUTION_FAILED_EVENT,
  ACTION_EXECUTION_SUCCEEDED_EVENT,
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

export {
  hasInputContract,
  inputRejectionMessage,
  validateActionInputs,
  type ActionInputValidation,
  type EntityResolver,
  type InputRejection,
} from './validation.js'

export {
  actionExecuted,
  buildIdempotencyKey,
  executionFailure,
  executionSuccess,
  EXECUTION_STATES,
  EXECUTION_STATUSES,
  POLICY_DECISIONS,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutionStatus,
  type ActionExecutor,
  type ExecutionState,
  type GatedAction,
  type PolicyDecision,
} from './execution.js'
