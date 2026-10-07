/**
 * Offline Decision Intelligence evaluation.
 *
 * What this tool occupies: a Decision Layer provider is worth what it does on
 * the reference tenant's real traffic, and the only way to know that before it
 * is wired into a turn is to score it against committed labels. So this package
 * holds two things and nothing else — the corpus, and the metric.
 *
 * What it holds no trace of is the part that changes often: which provider is
 * registered, which tenant configuration is in force, what credentials a live
 * provider needs. All three are the host's decision, which is why this barrel
 * exports no runner. The lead's live runner, when there is one, belongs beside
 * this file and imports it; nothing here imports it.
 *
 * Network-free by construction, not by discipline: nothing in this package
 * opens a connection, retries, or reads an environment variable. A test that
 * cannot reach the network is a property of the code, not of the CI sandbox —
 * which is also why this package imports nothing from `@archava/*`, so it stays
 * runnable in a repository state where the provider's package does not exist.
 */

export {
  DECISION_TASK_IDS,
  labelsOf,
  isKnownLabel,
  TASK_LABELS,
  type DecisionTaskId,
  type IntentLabel,
  type KnowledgeRoutingLabel,
  type ClarificationLabel,
  type HandoffLabel,
  type EvidenceLabel,
} from './tasks.js'

export {
  REFERENCE_CORPUS,
  CORPUS_LANGUAGE_COUNTS,
  CORPUS_SIZE,
  CORPUS_CORE_TASKS,
  corpusProblems,
  type CorpusLocale,
  type EvaluationCase,
  type ExpectedLabels,
} from './corpus.js'

export {
  ROUTING_TASK,
  STRUCTURED_TRUTH,
  RETRIEVAL,
  CRITICAL_FAILURE_KINDS,
  isCriticalDowngrade,
  findCriticalFailures,
  criticalCapacity,
  type CriticalFailure,
  type CriticalFailureKind,
} from './critical.js'

export {
  evaluate,
  scorePredictions,
  predictByCase,
  formatReport,
  type Predictions,
  type CasePredictor,
  type EvaluationReport,
  type TaskReport,
  type InvalidAnswer,
} from './metrics.js'
