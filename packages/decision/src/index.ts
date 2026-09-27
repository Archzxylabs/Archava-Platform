/**
 * The decision layer: bounded fuzzy judgment, behind the same discipline as
 * everything else in this platform.
 *
 * The layer does one thing. It asks a small number of *closed* questions about
 * a turn — what is the visitor doing, which source may answer, should we ask a
 * clarifying question, should a human hear about this, how much of the answer
 * do we already have — and it decides whether a provider's answer to one of
 * them is allowed to replace the deterministic answer. Nothing else. It writes
 * no prose, picks no action, grants no permission, and reads no clock that a
 * caller did not hand it.
 *
 * Four things to know before reading the code.
 *
 * **The catalogue is closed.** Five task ids, spelled once in `tasks.ts`.
 * Adding a sixth is a decision somebody makes — a new bounded question, a new
 * baseline, a new confidence policy — not a default. A task id nothing
 * configured is an id nothing asks: the orchestrator builds each question from
 * the catalogue, so a config typo fails closed instead of becoming a task.
 *
 * **The baseline is the caller's, not ours.** Every answer this package applies
 * or falls back to is handed in as a `BaselineAnswer`, with a `source` naming
 * where the deterministic answer came from. There is no default in here, and
 * that is not modesty: a fallback this package invented would be a second
 * opinion wearing the clothes of the first, and the hierarchy's entire argument
 * is that there is only one.
 *
 * **Confidence is not permission.** Two independent gates stand between a
 * provider's answer and a turn, and neither can substitute for the other: does
 * the answer validate (at run time, on the JSON that arrived), and does *this
 * task* permit the move (its own floor, its own disagreement policy). There is
 * no global threshold, because one number would be right for none of the five —
 * the cost of a wrong routing answer is a stale price under a citation, and the
 * cost of a wrong handoff flag is one extra line for a human to read.
 *
 * **A trace is metadata, never content.** Every `DecisionTrace` names the task,
 * the mode, the provider, the confidence, the candidate, the effective answer,
 * whether the answer in force came from the provider, and the latency — and the
 * type has nowhere to put an utterance, a piece of evidence, a credential, or a
 * tenant id. That is structural, not a convention a caller could forget.
 *
 * The package is network free. The provider it ships is a cue counter, not a
 * model, and it says so in its `model` label: it is the CI baseline, and it
 * exists so a real provider can be measured against something reproducible.
 */
export {
  DECISION_TASKS,
  DECISION_TASK_DEFINITIONS,
  asTaskAnswer,
  baselineProblem,
  decisionQuestionFor,
  isDecisionTask,
  asDecisionTask,
  taskAnswerProblem,
  type BaselineAnswer,
  type DecisionBaseline,
  type DecisionTask,
  type TaskAnswer,
  type TaskAnswers,
  type TaskDefinition,
} from './tasks.js'

export {
  TASK_POLICIES,
  ASSIST_MODES,
  agreementOf,
  answerRank,
  asAssistMode,
  confidenceProblem,
  disagreementProblem,
  isAssistMode,
  taskPolicy,
  taskPolicyProblem,
  type Agreement,
  type AssistMode,
  type DisagreementPolicy,
  type TaskPolicy,
} from './policy.js'

export {
  checkDecisionResponse,
  requestProblem,
  type CheckedDecision,
  type CheckedResponse,
  type ProviderIdentity,
  type ResponseCheck,
} from './validate.js'

export { CUES, mentions, normalizeCue, normalizeUtterance, type CueSet } from './vocabulary.js'

export { rankScoredOptions, type ScoredOption } from './ranking.js'

export {
  RuleDecisionProvider,
  NeverSettlingProvider,
  ThrowingProvider,
  scoreCoverage,
  ruleReportProblem,
  type RuleDecisionProviderOptions,
  type RuleReport,
} from './rule-provider.js'

export {
  DecisionOrchestrator,
  type AnswerSource,
  type CandidateAnswer,
  type CandidateDecision,
  type DecisionOrchestratorOptions,
  type DecisionRun,
  type DecisionTrace,
  type DecisionTurn,
  type EffectiveAnswer,
  type EffectiveDecision,
  type TraceOutcome,
} from './orchestrator.js'
