/**
 * The critical-failure rule.
 *
 * Counted separately from accuracy, on purpose. Accuracy treats every miss the
 * same, which is right for a judgement seam and wrong for this one: a provider
 * that says "retrieval" where the tenant's live system owns the answer has not
 * scored 50%, it has produced an unverified answer about money, availability or
 * a booking's status. PRD §17 forbids that downgrade outright, so it gets its
 * own counter, its own list of case ids, and its own test.
 *
 * The rule is one direction and one task. Asking `knowledge_routing` a
 * structured-truth question is not a failure; routing it back to retrieval is.
 * The reverse — sending a retrieval question to live systems — is scored as an
 * ordinary miss above, because the turn still answers correctly from published
 * knowledge and the failure is cost, not correctness.
 *
 * What is *not* counted here: a provider that returns nothing for such a case.
 * Silence is a miss and the harness reports it as unanswered, but the harness
 * cannot see what the pipeline did with that silence, so it does not get to
 * claim the pipeline downgraded anything.
 */

import type { ExpectedLabels } from './corpus.js'
import { type DecisionTaskId } from './tasks.js'

/** The task whose answer decides which knowledge may answer. */
export const ROUTING_TASK: DecisionTaskId = 'knowledge_routing'

/** The answer the tenant's live systems own. */
export const STRUCTURED_TRUTH = 'structured_truth'

/** The published-knowledge answer, which may support but never replace it. */
export const RETRIEVAL = 'retrieval'

/** Why a critical failure is critical, in one reportable phrase. */
export const CRITICAL_FAILURE_KINDS = ['structured_truth_to_retrieval'] as const

export type CriticalFailureKind = (typeof CRITICAL_FAILURE_KINDS)[number]

export interface CriticalFailure {
  readonly caseId: string
  readonly task: DecisionTaskId
  readonly expected: string
  readonly predicted: string
  readonly kind: CriticalFailureKind
}

/**
 * True when this single answer is the forbidden downgrade.
 *
 * Only ever true for a routing answer, so a provider that returns no label at
 * all for a case cannot trip it by accident.
 */
export function isCriticalDowngrade(
  task: DecisionTaskId,
  expected: string,
  predicted: string,
): boolean {
  return task === ROUTING_TASK && expected === STRUCTURED_TRUTH && predicted === RETRIEVAL
}

/** Every answer the harness scored, in the shape the critical rule reads. */
export interface ScoredAnswer {
  readonly caseId: string
  readonly task: DecisionTaskId
  readonly expected: string
  readonly predicted: string
}

/**
 * Collect every critical failure in one evaluation.
 *
 * `answers` is every expected/predicted pair the harness scored, including ones
 * whose predicted label fell outside the task's vocabulary — an unknown
 * prediction for a structured-truth case is still not the right routing.
 */
export function findCriticalFailures(answers: Iterable<ScoredAnswer>): CriticalFailure[] {
  const failures: CriticalFailure[] = []
  for (const answer of answers) {
    if (!isCriticalDowngrade(answer.task, answer.expected, answer.predicted)) continue
    failures.push({
      caseId: answer.caseId,
      task: answer.task,
      expected: answer.expected,
      predicted: answer.predicted,
      kind: 'structured_truth_to_retrieval',
    })
  }
  return failures
}

/**
 * How many critical failures the corpus could expose at most, i.e. how many of
 * its cases genuinely require a live-system answer. A report whose critical
 * count is zero against a corpus holding no such case has proved nothing, which
 * is why the corpus test asserts this is a comfortable number.
 */
export function criticalCapacity(
  cases: Iterable<{ readonly expected: Partial<ExpectedLabels> }>,
): number {
  let capacity = 0
  for (const evaluationCase of cases) {
    if (evaluationCase.expected[ROUTING_TASK] === STRUCTURED_TRUTH) capacity += 1
  }
  return capacity
}
