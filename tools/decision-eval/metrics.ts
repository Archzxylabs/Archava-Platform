/**
 * Provider-independent metrics.
 *
 * Scores answers, never produces them. `evaluate` takes the corpus and a table
 * of predictions keyed by case id; `predictByCase` takes a callback that
 * answers one case at a time. Both end in the same `scorePredictions`, so a
 * live provider, a mock and a committed fixture are all scored identically and
 * no test ever needs the network.
 *
 * Four things it deliberately does *not* do:
 *
 * - It does not own a provider registry. Resolving a provider id is the
 *   caller's job, so a provider that fails to resolve is their failure to
 *   report, not a zero-length metric here.
 * - It does not read the tenant configuration. Scoring against config would
 *   make this tool depend on the config package, which is the kind of coupling
 *   that leaves an eval unrunnable in a half-built repository.
 * - It does not score an unknown prediction as correct. An answer outside its
 *   task's vocabulary is counted as answered-but-wrong and listed in
 *   `invalidAnswers`, so a provider cannot earn accuracy by inventing labels.
 * - It does not score a task a case does not specify. A greeting has nothing to
 *   say about handoff; inventing an expected value would manufacture misses.
 */

import { findCriticalFailures, type CriticalFailure } from './critical.js'
import { REFERENCE_CORPUS, type EvaluationCase, type ExpectedLabels } from './corpus.js'
import { DECISION_TASK_IDS, labelsOf, type DecisionTaskId } from './tasks.js'

/** What a provider said for one case, keyed by task. Missing tasks are unanswered. */
export type Predictions = Partial<Record<DecisionTaskId, string>>

/** A provider under measurement. Returns nothing for a task it declines to answer. */
export type CasePredictor = (evaluationCase: EvaluationCase) => Predictions | Promise<Predictions>

/** One prediction the harness could not attribute to any label its task defines. */
export interface InvalidAnswer {
  readonly caseId: string
  readonly task: DecisionTaskId
  readonly predicted: string
}

export interface TaskReport {
  readonly task: DecisionTaskId
  /** Correct answers over answered questions. Unanswered questions count against it. */
  readonly accuracy: number
  readonly scored: number
  readonly correct: number
  readonly incorrect: number
  readonly unanswered: number
  /** Predicted-label counts, out-of-vocabulary predictions included under their own key. */
  readonly predictedCounts: Readonly<Record<string, number>>
  readonly expectedCounts: Readonly<Record<string, number>>
  /** Rows are expected labels, columns predicted ones, in vocabulary order. */
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>
}

export interface EvaluationReport {
  readonly total: number
  /** Correct answers over every question the corpus asked. */
  readonly accuracy: number
  readonly scored: number
  readonly correct: number
  readonly incorrect: number
  readonly unanswered: number
  readonly invalidAnswers: readonly InvalidAnswer[]
  readonly tasks: Readonly<Record<DecisionTaskId, TaskReport>>
  readonly criticalFailures: readonly CriticalFailure[]
  /** How many cases could have exposed a critical failure — what a zero is worth. */
  readonly criticalCapacity: number
}

interface TaskAccumulator {
  correct: number
  incorrect: number
  unanswered: number
  predictedCounts: Record<string, number>
  expectedCounts: Record<string, number>
  confusion: Record<string, Record<string, number>>
}

function newAccumulator(task: DecisionTaskId): TaskAccumulator {
  const labels = labelsOf(task)
  const confusion: Record<string, Record<string, number>> = {}
  for (const expected of labels) {
    confusion[expected] = {}
    for (const predicted of labels) confusion[expected][predicted] = 0
  }
  return {
    correct: 0,
    incorrect: 0,
    unanswered: 0,
    predictedCounts: {},
    expectedCounts: {},
    confusion,
  }
}

/** The expected label for a task, or undefined when the case does not specify one. */
function expectedFor(expected: ExpectedLabels, task: DecisionTaskId): string | undefined {
  return expected[task]
}

/**
 * Score one table of predictions against the corpus.
 *
 * Synchronous by design: a provider that needs the network is awaited by the
 * caller first, which is what keeps this file free of any transport, timeout or
 * credential of its own.
 */
export function scorePredictions(
  cases: readonly EvaluationCase[],
  predictions: Readonly<Record<string, Predictions>>,
): EvaluationReport {
  const accumulators = {} as Record<DecisionTaskId, TaskAccumulator>
  for (const task of DECISION_TASK_IDS) accumulators[task] = newAccumulator(task)

  const invalidAnswers: InvalidAnswer[] = []
  const scoredAnswers: {
    caseId: string
    task: DecisionTaskId
    expected: string
    predicted: string
  }[] = []
  let criticalCapacity = 0

  for (const evaluationCase of cases) {
    const given = predictions[evaluationCase.id] ?? {}
    for (const task of DECISION_TASK_IDS) {
      const expected = expectedFor(evaluationCase.expected, task)
      if (expected === undefined) continue

      const accumulator = accumulators[task]
      accumulator.expectedCounts[expected] = (accumulator.expectedCounts[expected] ?? 0) + 1
      const predicted = given[task]
      if (predicted === undefined) {
        accumulator.unanswered += 1
        continue
      }

      accumulator.predictedCounts[predicted] = (accumulator.predictedCounts[predicted] ?? 0) + 1

      if (!labelsOf(task).includes(predicted)) {
        invalidAnswers.push({ caseId: evaluationCase.id, task, predicted })
        accumulator.incorrect += 1
      } else if (predicted === expected) {
        accumulator.correct += 1
      } else {
        accumulator.incorrect += 1
      }

      // Recorded even out of vocabulary: dropping the answer would hide exactly
      // the mistake worth seeing, and a miss is a miss whatever its wording.
      const row = accumulator.confusion[expected]
      if (row) row[predicted] = (row[predicted] ?? 0) + 1

      scoredAnswers.push({ caseId: evaluationCase.id, task, expected, predicted })
    }
    if (expectedFor(evaluationCase.expected, 'knowledge_routing') === 'structured_truth')
      criticalCapacity += 1
  }

  const tasks = {} as Record<DecisionTaskId, TaskReport>
  let correct = 0
  let scored = 0
  let incorrect = 0
  let unanswered = 0

  for (const task of DECISION_TASK_IDS) {
    const accumulator = accumulators[task]
    const taskScored = accumulator.correct + accumulator.incorrect
    tasks[task] = {
      task,
      accuracy:
        taskScored + accumulator.unanswered === 0
          ? 0
          : accumulator.correct / (taskScored + accumulator.unanswered),
      scored: taskScored,
      correct: accumulator.correct,
      incorrect: accumulator.incorrect,
      unanswered: accumulator.unanswered,
      predictedCounts: accumulator.predictedCounts,
      expectedCounts: accumulator.expectedCounts,
      confusion: accumulator.confusion,
    }
    correct += accumulator.correct
    scored += taskScored
    incorrect += accumulator.incorrect
    unanswered += accumulator.unanswered
  }

  return {
    total: cases.length,
    accuracy: scored + unanswered === 0 ? 0 : correct / (scored + unanswered),
    scored,
    correct,
    incorrect,
    unanswered,
    invalidAnswers,
    tasks,
    criticalFailures: findCriticalFailures(scoredAnswers),
    criticalCapacity,
  }
}

/** Run `predictor` over the corpus, then score what it returned. */
export async function predictByCase(
  cases: readonly EvaluationCase[],
  predictor: CasePredictor,
): Promise<{ report: EvaluationReport; predictions: Record<string, Predictions> }> {
  const predictions: Record<string, Predictions> = {}
  for (const evaluationCase of cases)
    predictions[evaluationCase.id] = await predictor(evaluationCase)
  return { report: scorePredictions(cases, predictions), predictions }
}

/** Score the committed reference corpus in one call. */
export function evaluate(
  predictions: Readonly<Record<string, Predictions>>,
  cases: readonly EvaluationCase[] = REFERENCE_CORPUS,
): EvaluationReport {
  return scorePredictions(cases, predictions)
}

/**
 * A readable report, for a human reading CI output. Not part of the metric: the
 * numbers above are the contract, this is only their printing.
 */
export function formatReport(report: EvaluationReport): string {
  const lines: string[] = [
    `cases: ${report.total}  answers scored: ${report.scored}`,
    `accuracy: ${percent(report.accuracy)} (correct ${report.correct}, incorrect ${report.incorrect}, unanswered ${report.unanswered})`,
  ]
  for (const task of DECISION_TASK_IDS) {
    const taskReport = report.tasks[task]
    if (taskReport.scored + taskReport.unanswered === 0) continue
    lines.push(
      `  ${task}: ${percent(taskReport.accuracy)} (${taskReport.correct}/${taskReport.scored + taskReport.unanswered}, ${taskReport.unanswered} unanswered)`,
    )
    for (const label of labelsOf(task)) {
      const expectedCount = taskReport.expectedCounts[label] ?? 0
      if (expectedCount === 0) continue
      const hit = taskReport.confusion[label]?.[label] ?? 0
      lines.push(`    ${label}: ${hit}/${expectedCount}`)
    }
  }
  lines.push(
    `critical failures: ${report.criticalFailures.length} of ${report.criticalCapacity} at risk`,
  )
  for (const failure of report.criticalFailures) {
    lines.push(`  ${failure.caseId}: ${failure.expected} -> ${failure.predicted} (${failure.kind})`)
  }
  if (report.invalidAnswers.length > 0) {
    lines.push(`out-of-vocabulary predictions: ${report.invalidAnswers.length}`)
    for (const invalid of report.invalidAnswers) {
      lines.push(`  ${invalid.caseId} [${invalid.task}]: ${invalid.predicted}`)
    }
  }
  return lines.join('\n')
}

function percent(accuracy: number): string {
  return `${(accuracy * 100).toFixed(1)}%`
}
