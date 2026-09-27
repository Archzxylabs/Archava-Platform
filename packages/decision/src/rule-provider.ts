/**
 * The deterministic provider: the CI and evaluation baseline.
 *
 * It answers the same questions a live model would, from the same request, with
 * no network, no credentials and no clock — which is what makes a reproducible
 * evaluation possible. It is also not a model, and it does not pretend to be:
 * where a model reasons about a sentence, this counts cues and reports how many
 * fired. The confidence describes the counting; it is not a claim about the
 * world.
 *
 * Three rules keep it honest enough to be a baseline rather than a competitor.
 *
 * 1. It answers only what it was asked, by task id. A question it has no cue
 *    table for is *refused*, not guessed — the port's `refused` list exists
 *    precisely so a provider can decline, and a baseline that invented answers
 *    to questions it did not understand would be measuring the wrong thing.
 * 2. Its confidence comes from agreement, not from assertion. One cue is worth
 *    less than three, and no number of cues is worth 1.0: a heuristic cannot be
 *    certain of anything, and reporting certainty would make every floor the
 *    catalogue sets meaningless, because a baseline that clears them all is a
 *    baseline that tests nothing.
 * 3. It never leaves the shape it was handed. The reply carries the identity it
 *    was built with, one entry per asked question, and nothing else.
 *
 * It is deliberately cruder than Foundation's own classifier. Two baselines
 * that agree on everything cannot tell you whether a model helps; this one is
 * close enough to be plausible and different enough to be measured.
 */
import type {
  Decision,
  DecisionRefusal,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '@archava/adapters'
import {
  asDecisionTask,
  asTaskAnswer,
  taskAnswerProblem,
  type DecisionTask,
  type TaskAnswer,
} from './tasks.js'
import { requestProblem } from './validate.js'
import { CUES, mentions, normalizeCue, normalizeUtterance, type CueSet } from './vocabulary.js'

/**
 * What this provider answers, and how much the answer is worth.
 *
 * A union rather than a record with a nullable answer, because "I did not
 * answer" is a different fact from "I answered, weakly" — the first is a
 * refusal the caller can read, and collapsing the two is how a zero-confidence
 * default gets applied as though a provider had chosen it.
 */
export type RuleReport =
  | {
      readonly task: DecisionTask
      readonly kind: 'answered'
      readonly answer: TaskAnswer<DecisionTask>
      /** Bounded 0..1, and never 1. See rule 2 above. */
      readonly confidence: number
      /** How the answer was reached, for a test that wants to know why. */
      readonly basis: string
    }
  | {
      readonly task: DecisionTask
      readonly kind: 'refused'
      /** Why, in the words a reader of the trace will see. */
      readonly basis: string
    }

export interface RuleDecisionProviderOptions {
  readonly providerId?: string
  readonly model?: string
}

/**
 * The baseline, as an object that satisfies the frozen port.
 *
 * It carries an identity because the port's reply names a `providerId` and
 * `model`, and the boundary checks the reply against the provider that was
 * asked. Both labels here are honest about what this is; a provider reporting
 * itself as something else would make the trace wrong on purpose.
 */
export class RuleDecisionProvider {
  readonly providerId: string
  readonly model: string
  readonly health = { ready: true, reason: 'deterministic, offline, cue based' }

  constructor(options: RuleDecisionProviderOptions = {}) {
    this.providerId = options.providerId ?? 'rule-baseline'
    this.model = options.model ?? 'cue-heuristic/v1'
  }

  /**
   * The reply the port expects, for a request that was already validated.
   *
   * Not `async`: nothing here awaits, and a provider that answers synchronously
   * should say so rather than dress a finished answer as a pending one. The port
   * asks for a promise, and `Promise.resolve` is the honest one.
   */
  decide(request: DecisionRequest): Promise<DecisionResult> {
    const utterance = normalizeUtterance(request.utterance)
    const decisions: Decision[] = []
    const refused: DecisionRefusal[] = []
    for (const question of request.questions) {
      const task = asDecisionTask(question.id)
      if (task === null) {
        refused.push({ id: question.id, reason: 'this question is not a task in the catalogue' })
        continue
      }
      const report = this.reportTask(task, utterance, request.evidence)
      if (report.kind === 'refused') {
        refused.push({ id: question.id, reason: report.basis })
        continue
      }
      const answer = asTaskAnswer(task, report.answer)
      const decision = answer === null ? null : asDecision(question, answer, report.confidence)
      if (decision === null) {
        refused.push({ id: question.id, reason: `${task} answered outside its own answer set` })
        continue
      }
      decisions.push(decision)
    }
    return Promise.resolve({ providerId: this.providerId, model: this.model, decisions, refused })
  }

  /** What this provider would answer about one task, and why. */
  reportTask(
    task: DecisionTask,
    utterance: string,
    evidence: Readonly<Record<string, unknown>> = {},
  ): RuleReport {
    if (task === 'evidence_sufficiency') return reportCoverage(evidence)
    const table = CUES[task]
    if (table === undefined) {
      return { task, kind: 'refused', basis: 'this question has no cue table here' }
    }
    return reportFromCues(task, utterance, table)
  }

  /**
   * Every task this provider would answer for a request, as reports.
   *
   * The evaluation harness uses this rather than `decide`, because a harness
   * measuring agreement needs the refusals as first-class reports and not as a
   * list it has to pair up with the question ids by hand. A malformed request
   * yields nothing, for the same reason `checkDecisionResponse` refuses one:
   * there is no honest answer to a question that was not properly asked.
   */
  report(request: DecisionRequest): readonly RuleReport[] {
    if (requestProblem(request) !== null) return []
    const utterance = normalizeUtterance(request.utterance)
    return request.questions
      .map((question) => asDecisionTask(question.id))
      .filter((task): task is DecisionTask => task !== null)
      .map((task) => this.reportTask(task, utterance, request.evidence))
  }
}

/**
 * Count cues, then state the answer and how much the count is worth.
 *
 * The confidence formula decides what the baseline can prove, so it is written
 * out rather than hidden in a constant:
 *
 * - Nothing fires: a refusal. A provider with nothing to read says nothing, and
 *   the port has a list for exactly this.
 * - The tally ties or is negative: the same. A tie is not an answer.
 * - One cue decides it: 0.3, below every task's floor. One word is a hint.
 * - Two cues decide it: 0.65, above most floors and below routing's.
 * - Three or more: 0.85, high enough to apply where a task allows it.
 *
 * The ceiling stops short of 1.0 on purpose. See rule 2 above.
 */
function reportFromCues(
  task: DecisionTask,
  utterance: string,
  table: Readonly<Record<string, CueSet>>,
): RuleReport {
  const tallies: Array<{ label: string; tally: number; cues: number }> = []
  for (const [label, cues] of Object.entries(table)) {
    let tally = 0
    let fired = 0
    for (const cue of cues.toward) {
      if (mentions(utterance, normalizeCue(cue))) {
        tally += 1
        fired += 1
      }
    }
    for (const cue of cues.away ?? []) {
      if (mentions(utterance, normalizeCue(cue))) tally -= 1
    }
    tallies.push({ label, tally, cues: fired })
  }
  tallies.sort((left, right) => right.tally - left.tally || right.cues - left.cues)

  const best = tallies[0]
  if (best === undefined || best.tally <= 0) {
    return {
      task,
      kind: 'refused',
      basis: best === undefined ? 'this question has no answers' : 'no cue decided it',
    }
  }
  const runnerUp = tallies[1]
  if (runnerUp !== undefined && runnerUp.tally === best.tally) {
    return { task, kind: 'refused', basis: 'the cues tied' }
  }
  const candidate =
    task === 'clarification' || task === 'handoff_recommendation'
      ? best.label === 'true'
      : best.label
  const answer = asTaskAnswer(task, candidate)
  if (answer === null) {
    return { task, kind: 'refused', basis: `${best.label} is not an answer this task offers` }
  }
  return {
    task,
    kind: 'answered',
    answer,
    confidence: confidenceFor(best.cues),
    basis: `${best.cues} cue(s) for ${best.label}`,
  }
}

/** How many cues fired, and how much that is worth. See the note above. */
function confidenceFor(cueCount: number): number {
  if (cueCount <= 0) return 0
  if (cueCount === 1) return 0.3
  if (cueCount === 2) return 0.65
  return 0.85
}

/**
 * Coverage of the supplied facts, on [0, 1].
 *
 * Measured from the evidence and not from the utterance, because that is what
 * the task asks about: how much of the answer the supplied facts already cover.
 * An utterance cannot know that, and a score derived from the words alone would
 * be fluency reported as coverage.
 *
 * The tenant id and the locale are on every request, so they are not evidence.
 * What is counted is how many named facts arrived, damped: five facts is full
 * coverage for the questions this package asks, and beyond that there is
 * nothing left to measure. Empty evidence scores 0, which is honest — nothing
 * was supplied — and no score here reaches 1.0, because a heuristic can say
 * that some facts arrived, not that they suffice.
 *
 * The 0.5 confidence is the count's worth, not the facts' worth: that facts
 * arrived is arithmetic, that they suffice is not. It sits below the floor this
 * task set for itself, which is the right place for it — a baseline whose
 * coverage estimate can already replace a caller's own judgement is a baseline
 * that has stopped being one.
 */
function reportCoverage(evidence: Readonly<Record<string, unknown>>): RuleReport {
  return {
    task: 'evidence_sufficiency',
    kind: 'answered',
    answer: scoreCoverage(evidence),
    confidence: 0.5,
    basis: 'measured from the supplied facts',
  }
}

/** Coverage of the supplied facts, damped so no count reaches 1. */
export function scoreCoverage(evidence: Readonly<Record<string, unknown>>): number {
  const count = Object.keys(evidence).length
  if (count === 0) return 0
  return Math.min(count / 5, 0.8)
}

/**
 * The port's `Decision` for one question, or null when the value does not fit.
 *
 * Narrowing rather than casting, and a null rather than a coerced value: the
 * one case this can refuse is one `asTaskAnswer` has already ruled out, so the
 * null branch is unreachable by construction — but it is unreachable in the
 * caller's favour, because a value that somehow does not fit is a refusal and
 * not a boolean somebody invented.
 */
function asDecision(
  question: DecisionQuestion,
  answer: TaskAnswer<DecisionTask>,
  confidence: number,
): Decision | null {
  if (question.kind === 'boolean' && typeof answer === 'boolean') {
    return { id: question.id, kind: 'boolean', answer, confidence }
  }
  if (question.kind === 'choice' && typeof answer === 'string') {
    return { id: question.id, kind: 'choice', answer, confidence }
  }
  if (question.kind === 'score' && typeof answer === 'number') {
    return { id: question.id, kind: 'score', answer, confidence }
  }
  return null
}

/**
 * Whether a report is the honest baseline it claims to be.
 *
 * Exported because that is a property worth checking rather than assuming, and
 * the check belongs next to the thing it checks.
 */
export function ruleReportProblem(report: RuleReport): string | null {
  if (report.kind === 'refused') {
    return report.basis.trim() === '' ? `report for ${report.task} needs a stated basis` : null
  }
  if (!Number.isFinite(report.confidence) || report.confidence < 0 || report.confidence > 1) {
    return `report for ${report.task} has a confidence outside [0, 1]`
  }
  if (report.confidence === 1) return `report for ${report.task} claims certainty`
  if (report.basis.trim() === '') return `report for ${report.task} needs a stated basis`
  const problem = taskAnswerProblem(report.task, report.answer)
  return problem === undefined ? null : problem
}

/** A provider that throws. Only tests use this. */
export class ThrowingProvider {
  readonly providerId = 'throwing'
  readonly model = 'always-fails'
  readonly health = { ready: true, reason: 'a provider that always rejects' }
  private readonly error: Error

  constructor(error: Error = new Error('this provider always fails')) {
    this.error = error
  }

  /** Thrown rather than returned: a rejected promise, the way a provider does. */
  decide(): Promise<DecisionResult> {
    return Promise.reject(this.error)
  }
}

/** A provider that never settles. Only tests use this. */
export class NeverSettlingProvider {
  readonly providerId = 'never-settling'
  readonly model = 'never-answers'
  readonly health = { ready: true, reason: 'a provider that never answers' }

  decide(): Promise<DecisionResult> {
    return new Promise<DecisionResult>(() => undefined)
  }
}
