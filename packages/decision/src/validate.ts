/**
 * Runtime validation at the provider boundary.
 *
 * A provider's reply is parsed JSON that arrived over a wire, and nothing on
 * the TypeScript side of that wire has seen it. So the request and the reply are
 * both checked here, at run time, and a failure closes the whole response
 * rather than the offending item: a reply that answers four questions out of
 * five is not 80% of an answer, it is a reply that did not know what it was
 * asked.
 *
 * The unit of trust is a *complete* answer. There is no partial acceptance,
 * because a caller holding a partial answer cannot tell which of the five it
 * is missing, and the one it is missing is the one that mattered.
 *
 * Every refusal here is a plain string naming what was wrong, in terms a reader
 * can act on, and it carries no provider output — so it can travel into a trace
 * without becoming a channel for anything the provider said.
 */
import {
  decisionQuestionProblem,
  type Decision,
  type DecisionQuestion,
  type DecisionRequest,
} from '@archava/adapters'
import {
  DECISION_TASK_DEFINITIONS,
  asDecisionTask,
  asTaskAnswer,
  type DecisionTask,
  type TaskAnswer,
} from './tasks.js'

/** Who a reply is claimed to be from, and who it was asked of. */
export interface ProviderIdentity {
  readonly providerId: string
  readonly model: string
}

/** One decision the boundary accepted, already narrowed to its task's answers. */
export interface CheckedDecision {
  readonly decision: Decision
  readonly answer: TaskAnswer<DecisionTask>
  readonly confidence: number
}

/** A reply the boundary accepted, in full. */
export interface CheckedResponse {
  readonly providerId: string
  readonly model: string
  /** Every id the request asked appears exactly once — here or in `refusals`. */
  readonly decisions: ReadonlyMap<DecisionTask, CheckedDecision>
  /** The provider's own account of why it did not answer, verbatim, per task. */
  readonly refusals: ReadonlyMap<DecisionTask, string>
}

export type ResponseCheck =
  | { readonly ok: true; readonly checked: CheckedResponse }
  | { readonly ok: false; readonly problem: string }

/**
 * Whether a value is the list of questions a request claims to carry.
 *
 * A type predicate rather than a bare `Array.isArray` because narrowing a
 * `readonly` array with `Array.isArray` yields `any[]`, which would silently
 * untype every question the loop below reads. Naming the element type keeps the
 * check at run time and the type at compile time.
 */
function isQuestionList(value: unknown): value is readonly DecisionQuestion[] {
  return Array.isArray(value)
}

/**
 * Whether a request is worth sending.
 *
 * Checked here rather than trusted from the caller's types, because the
 * catalogue — not the port — decides which ids exist. A request carrying a task
 * this package does not have would be answered in a vocabulary the evaluator
 * cannot read, and the mistake would surface as a malformed reply rather than
 * as the malformed request it was.
 */
export function requestProblem(request: DecisionRequest): string | null {
  if (typeof request.tenantId !== 'string' || request.tenantId.trim() === '') {
    return 'a decision request needs a tenant id'
  }
  if (typeof request.locale !== 'string' || request.locale.trim() === '') {
    return 'a decision request needs a locale'
  }
  if (typeof request.utterance !== 'string') return 'a decision request needs an utterance'
  if (!isQuestionList(request.questions) || request.questions.length === 0) {
    return 'a decision request needs at least one question'
  }
  const seen = new Set<string>()
  for (const question of request.questions) {
    const shape = decisionQuestionProblem(question)
    if (shape !== null) return shape
    if (seen.has(question.id)) return `question ${question.id} was asked twice in one request`
    seen.add(question.id)
    const task = asDecisionTask(question.id)
    if (task === null) {
      return `question ${question.id} is not a task in the catalogue`
    }
    if (DECISION_TASK_DEFINITIONS[task].kind !== question.kind) {
      return `question ${question.id} was asked as a ${question.kind}, not a ${DECISION_TASK_DEFINITIONS[task].kind}`
    }
  }
  return null
}

/** The shape of one raw decision, against the question it must answer. */
function decisionProblem(question: DecisionQuestion, raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return `answer for ${question.id} must be an object`
  const candidate = raw as Partial<Decision>
  if (candidate.id !== question.id) return `answer for ${question.id} carries a different id`
  if (candidate.kind !== question.kind) {
    return `answer for ${question.id} is a ${String(candidate.kind)}, not a ${question.kind}`
  }
  const confidence = candidate.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return `confidence for ${question.id} must be a finite number`
  }
  if (confidence < 0 || confidence > 1) return `confidence for ${question.id} is outside [0, 1]`
  const answer = candidate.answer
  if (question.kind === 'choice') {
    if (typeof answer !== 'string') return `answer for ${question.id} must be one of its options`
    if (!(question.options ?? []).includes(answer)) {
      return `answer for ${question.id} is not in its answer set`
    }
    return null
  }
  if (question.kind === 'score') {
    if (typeof answer !== 'number' || !Number.isFinite(answer)) {
      return `answer for ${question.id} must be a finite number`
    }
    const [low, high] = question.bounds ?? [0, 1]
    if (answer < low || answer > high) return `answer for ${question.id} is outside its range`
    return null
  }
  return typeof answer === 'boolean' ? null : `answer for ${question.id} must be a boolean`
}

/**
 * Check a provider's reply against the request it is meant to answer.
 *
 * `expected` is the provider that was asked. A reply naming a different one is
 * refused: the alternative is a candidate attributed to a model that never
 * produced it, which is worse than no candidate, because a trace that lies is
 * a trace a reader has no way to catch.
 */
export function checkDecisionResponse(
  response: unknown,
  request: DecisionRequest,
  expected: ProviderIdentity,
): ResponseCheck {
  const asked = requestProblem(request)
  if (asked !== null) return { ok: false, problem: asked }

  if (expected.providerId.trim() === '' || expected.model.trim() === '') {
    return {
      ok: false,
      problem: 'a provider without an identity cannot be traced, so it cannot answer',
    }
  }
  if (typeof response !== 'object' || response === null) {
    return { ok: false, problem: 'a provider reply must be an object' }
  }
  const reply = response as {
    providerId?: unknown
    model?: unknown
    decisions?: unknown
    refused?: unknown
  }
  if (reply.providerId !== expected.providerId || reply.model !== expected.model) {
    return {
      ok: false,
      problem: 'a provider replied under a different identity than it was asked with',
    }
  }
  if (!Array.isArray(reply.decisions) || !Array.isArray(reply.refused)) {
    return { ok: false, problem: 'a provider reply needs both a decisions list and a refused list' }
  }

  const decisions = new Map<DecisionTask, CheckedDecision>()
  for (const raw of reply.decisions) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, problem: 'a provider sent an answer that is not an object' }
    }
    const id = (raw as { id?: unknown }).id
    const question = request.questions.find((candidate) => candidate.id === id)
    const task = asDecisionTask(id)
    if (question === undefined || task === null) {
      return {
        ok: false,
        problem: `a provider answered a question that was not asked: ${String(id)}`,
      }
    }
    if (decisions.has(task)) {
      return { ok: false, problem: `a provider answered ${task} twice in one reply` }
    }
    const problem = decisionProblem(question, raw)
    if (problem !== null) return { ok: false, problem }
    const decision = raw as Decision
    const answer = asTaskAnswer(task, decision.answer)
    if (answer === null)
      return { ok: false, problem: `answer for ${task} is not one of its answers` }
    decisions.set(task, { decision, answer, confidence: decision.confidence })
  }

  const refusals = new Map<DecisionTask, string>()
  for (const raw of reply.refused) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, problem: 'a provider sent a refusal that is not an object' }
    }
    const refusal = raw as { id?: unknown; reason?: unknown }
    const task = asDecisionTask(refusal.id)
    if (task === null || !request.questions.some((question) => question.id === refusal.id)) {
      return {
        ok: false,
        problem: `a provider refused a question that was not asked: ${String(refusal.id)}`,
      }
    }
    if (decisions.has(task) || refusals.has(task)) {
      return { ok: false, problem: `a provider answered and refused ${task}` }
    }
    if (typeof refusal.reason !== 'string' || refusal.reason.trim() === '') {
      return { ok: false, problem: `a refusal for ${task} needs a reason somebody can read` }
    }
    refusals.set(task, refusal.reason)
  }

  for (const question of request.questions) {
    const task = asDecisionTask(question.id)
    if (task === null)
      return { ok: false, problem: `question ${question.id} is not a task in the catalogue` }
    if (!decisions.has(task) && !refusals.has(task)) {
      return { ok: false, problem: `a provider left ${task} unanswered` }
    }
  }

  return {
    ok: true,
    checked: { providerId: expected.providerId, model: expected.model, decisions, refusals },
  }
}
