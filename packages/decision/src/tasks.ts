/**
 * The task catalogue: the bounded questions a DecisionProvider may be asked.
 *
 * A `DecisionProvider` is asked *questions*, not given a job. The port carries
 * three kinds — boolean, choice, score — and nothing else can cross it, so a
 * task is nothing more than a named, typed, closed-answer question. That is
 * deliberate: the moment a task could ask for prose it would be a brain, and
 * the authority hierarchy would have a provider in it that writes the answer.
 *
 * Five tasks start the catalogue. Adding a sixth is a new question with a new
 * bounded answer set, a new baseline and a new confidence policy — a decision
 * someone makes, not a default. Nothing here grows to accommodate a use case
 * nobody has reviewed; the narrowing helper for an id is exported precisely so
 * a config typo fails closed instead of becoming a task.
 *
 * Every answer set is closed, every one has an honest way to say "this is not
 * mine to answer", and none of them can carry an instruction. A provider that
 * wants to act is a provider that has left this package.
 */
import type { DecisionKind, DecisionQuestion } from '@archava/adapters'

/**
 * The stable ids.
 *
 * Spelled once, here. They appear in an audit trail, in a tenant's config and
 * in an evaluation corpus, so they are data rather than identifiers: renaming
 * one is a migration, and a synonym added later is an alias, not a sixth task.
 */
export const DECISION_TASKS = [
  'intent_classification',
  'knowledge_routing',
  'clarification',
  'handoff_recommendation',
  'evidence_sufficiency',
] as const

export type DecisionTask = (typeof DECISION_TASKS)[number]

/**
 * What each task may answer.
 *
 * A mapped record rather than a union, so a consumer that narrows on `task`
 * narrows on `answer` in the same breath — no second discriminant, no cast.
 * `TaskAnswer<'handoff_recommendation'>` is `boolean`, not `boolean | 'yes' | 'no'`,
 * because a provider answering in a vocabulary the question did not offer has
 * not answered.
 */
export interface TaskAnswers {
  /** What the visitor is doing, which decides the posture of the reply. */
  intent_classification:
    | 'availability_inquiry'
    | 'pricing_inquiry'
    | 'policy_inquiry'
    | 'status_inquiry'
    | 'support_request'
    | 'recommendation_request'
    | 'comparison_request'
    | 'handoff_request'
    | 'purchase_request'
    | 'general_inquiry'
  /** Which source is allowed to answer, per §17. */
  knowledge_routing: 'retrieval_knowledge' | 'structured_truth'
  /** Whether a clarifying question is worth one round trip. */
  clarification: boolean
  /** Whether a human should be told about this turn. Never an action. */
  handoff_recommendation: boolean
  /** How much of the answer the grounded facts already cover, in [0, 1]. */
  evidence_sufficiency: number
}

/** The answer type for one task. */
export type TaskAnswer<T extends DecisionTask> = TaskAnswers[T]

/** One task, described: the question asked, and the answers it may return. */
export interface TaskDefinition {
  readonly id: DecisionTask
  readonly kind: DecisionKind
  /** Shown to the provider verbatim. A prompt that names a tenant schema is a leak. */
  readonly prompt: string
  /** The closed answer set for a `choice` task, in ascending escalation order. */
  readonly options: readonly string[]
  /** The inclusive range for a `score` task. */
  readonly bounds: readonly [number, number]
  /** Why the task exists, and what it may never decide. */
  readonly why: string
}

export const DECISION_TASK_DEFINITIONS: Readonly<Record<DecisionTask, TaskDefinition>> = {
  intent_classification: {
    id: 'intent_classification',
    kind: 'choice',
    prompt: 'Which kind of turn is this utterance?',
    options: [
      'availability_inquiry',
      'pricing_inquiry',
      'policy_inquiry',
      'status_inquiry',
      'support_request',
      'recommendation_request',
      'comparison_request',
      'handoff_request',
      'purchase_request',
      'general_inquiry',
    ],
    bounds: [0, 1],
    why:
      'The posture of a reply follows from what the visitor is doing, and a turn that is ' +
      'mostly one thing with a second thing attached is exactly the case a lexical ' +
      'classifier gets wrong in one direction. `general_inquiry` covers an utterance ' +
      'outside the specific catalogue without granting any action. It authorizes nothing — least of all ' +
      'a page action.',
  },
  knowledge_routing: {
    id: 'knowledge_routing',
    kind: 'choice',
    prompt: 'Which source may answer this utterance, structured truth or retrieval?',
    options: ['retrieval_knowledge', 'structured_truth'],
    bounds: [0, 1],
    why:
      '§17 puts live values in the hands of the live system and published copy in the hands ' +
      'of retrieval, and the two are not interchangeable: a stale price quoted from a chunk ' +
      'is a wrong answer wearing a citation. The order of `options` is the escalation ladder ' +
      '— retrieval is the floor, structured truth is above it — so the policy can refuse a ' +
      'move in one direction while permitting the other.',
  },
  clarification: {
    id: 'clarification',
    kind: 'boolean',
    prompt: 'Should the assistant ask one clarifying question before answering?',
    options: [],
    bounds: [0, 1],
    why:
      'A clarifying question costs the visitor a round trip, so it has to be worth one. This ' +
      'task asks whether it is — when an utterance could be about two different things and ' +
      'answering either way would be a guess. It never asks the question on the provider’s ' +
      'behalf: the words come from the brain, and a provider that wanted to write them would ' +
      'need a kind this port does not have.',
  },
  handoff_recommendation: {
    id: 'handoff_recommendation',
    kind: 'boolean',
    prompt: 'Should a member of staff be told about this turn?',
    options: [],
    bounds: [0, 1],
    why:
      'A turn a visitor wants to have with a human is a turn a human should hear about, and ' +
      'detecting it is fuzzy in a way a keyword match is not — "this is the third time I am ' +
      'asking" carries no keyword. What the flag does is limited on purpose: it tells a human ' +
      'that a turn happened. It never books, never confirms, never grants a permission ' +
      'ActionPolicy did not already grant, and never sends anything the visitor did not ask ' +
      'for.',
  },
  evidence_sufficiency: {
    id: 'evidence_sufficiency',
    kind: 'score',
    prompt: 'How much of the answer do the supplied facts already cover, from 0 to 1?',
    options: [],
    bounds: [0, 1],
    why:
      'A score rather than a boolean because "enough" has a gradient a caller may want to ' +
      'act on: a turn with 0.4 coverage is not a turn to answer from nothing. The facts are ' +
      'the projected ones in the request — ids, labels, counts, flags — never the utterance ' +
      'and never the tenant’s schema, so the highest score here is a statement about what ' +
      'was supplied and not a claim about the world.',
  },
}

/** The question for one task, built from the catalogue rather than hand-written. */
export function decisionQuestionFor(task: DecisionTask): DecisionQuestion {
  const definition = DECISION_TASK_DEFINITIONS[task]
  const question: DecisionQuestion = {
    id: task,
    kind: definition.kind,
    prompt: definition.prompt,
  }
  if (definition.kind === 'choice') return { ...question, options: definition.options }
  if (definition.kind === 'score') return { ...question, bounds: definition.bounds }
  return question
}

/** True when `task` is in the catalogue, so a config typo fails loudly. */
export function isDecisionTask(task: unknown): task is DecisionTask {
  return typeof task === 'string' && (DECISION_TASKS as readonly string[]).includes(task)
}

/** Narrows an unknown id, or null when it is not in the catalogue. */
export function asDecisionTask(task: unknown): DecisionTask | null {
  return isDecisionTask(task) ? task : null
}

/**
 * The deterministic answer, carried explicitly.
 *
 * The orchestrator never invents a fallback. A caller hands it the answer
 * Foundation would have given with no provider at all — from code, or from the
 * structured source — and every failure path returns that same value. A default
 * baseline inside this package would be a second opinion wearing the clothes of
 * the first, and the entire argument of the hierarchy is that there is only one.
 */
export interface BaselineAnswer<T extends DecisionTask> {
  readonly task: T
  readonly answer: TaskAnswer<T>
  /** Where the deterministic answer came from. Audit trail, not logic. */
  readonly source: string
}

export type DecisionBaseline = { [T in DecisionTask]: BaselineAnswer<T> }[DecisionTask]

/**
 * Whether `value` is an answer this task may return.
 *
 * Runtime, not type-level. A provider's reply arrives as parsed JSON at a
 * boundary no type protects, and a `choice` answer naming an option nobody
 * listed is how a closed answer set stops being closed.
 */
export function taskAnswerProblem(task: DecisionTask, value: unknown): string | null {
  const definition = DECISION_TASK_DEFINITIONS[task]
  if (definition.kind === 'boolean') {
    return typeof value === 'boolean' ? null : `answer for ${task} must be a boolean`
  }
  if (definition.kind === 'choice') {
    if (typeof value !== 'string') return `answer for ${task} must be one of its options`
    return definition.options.includes(value) ? null : `answer for ${task} is not in its answer set`
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `answer for ${task} must be a finite number`
  }
  const [low, high] = definition.bounds
  if (value < low || value > high) return `answer for ${task} is outside its range`
  return null
}

/**
 * Narrows an unknown value to this task's answer type, or null.
 *
 * Used at the provider boundary, where the value is whatever JSON said. The
 * predicate above is the whole check; this exists so no caller has to write its
 * own assertion and no assertion ever loses its comment.
 */
export function asTaskAnswer<T extends DecisionTask>(
  task: T,
  value: unknown,
): TaskAnswer<T> | null {
  if (taskAnswerProblem(task, value) !== null) return null
  // The check above is the guard. This is the one seam where the runtime test
  // and the static type are stitched together, kept in one place so the cast
  // has a witness.
  return value as TaskAnswer<T>
}

/** Whether a baseline is usable at all, before any provider is consulted. */
export function baselineProblem(baseline: BaselineAnswer<DecisionTask>): string | null {
  const problem = taskAnswerProblem(baseline.task, baseline.answer)
  if (problem !== null) return problem
  return baseline.source.trim() === '' ? `baseline for ${baseline.task} needs a source` : null
}
