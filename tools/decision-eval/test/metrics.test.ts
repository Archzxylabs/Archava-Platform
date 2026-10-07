/**
 * Metric tests.
 *
 * These are calibration tests, not quality tests: the metric is right when it
 * reports a perfect answer as perfect, a wrong answer as wrong, silence as
 * unanswered, and an invented label as a bug. A harness that scored a fabricated
 * label as correct would let a provider earn accuracy by making words up, and a
 * harness that scored silence as wrong would punish the one behaviour a provider
 * should sometimes choose — so both are pinned down here.
 *
 * Nothing here touches the network. Every provider in this file is a lookup over
 * the committed corpus, which is the whole point of scoring predictions rather
 * than calling models.
 */

import { describe, expect, it } from 'vitest'

import { REFERENCE_CORPUS, type EvaluationCase } from '../corpus.js'
import {
  evaluate,
  formatReport,
  predictByCase,
  scorePredictions,
  type CasePredictor,
  type Predictions,
} from '../metrics.js'
import { DECISION_TASK_IDS, labelsOf, type DecisionTaskId } from '../tasks.js'

/** A provider that agrees with the corpus on every task. */
function perfect(evaluationCase: EvaluationCase): Predictions {
  return { ...evaluationCase.expected }
}

/** The next label the task defines, so the answer is always wrong but never invented. */
function shiftLabel(task: DecisionTaskId, label: string): string {
  const labels = labelsOf(task)
  return labels[(labels.indexOf(label) + 1) % labels.length] ?? label
}

/** A provider that answers every task, and answers all of them wrong. */
function allWrong(evaluationCase: EvaluationCase): Predictions {
  const predictions: Predictions = {}
  for (const task of DECISION_TASK_IDS) {
    const expected = evaluationCase.expected[task]
    if (expected === undefined) continue
    predictions[task] = shiftLabel(task, expected)
  }
  return predictions
}

function fromPredictor(
  predictor: (evaluationCase: EvaluationCase) => Predictions,
): Record<string, Predictions> {
  const predictions: Record<string, Predictions> = {}
  for (const evaluationCase of REFERENCE_CORPUS)
    predictions[evaluationCase.id] = predictor(evaluationCase)
  return predictions
}

function caseWith(expected: EvaluationCase['expected'], id = 'c1'): EvaluationCase {
  return {
    id,
    locale: 'en',
    utterance: 'What is your cancellation policy?',
    expected,
    why: 'fixture',
  }
}

describe('scorePredictions', () => {
  it('scores a provider that agrees with the corpus as perfect', () => {
    const report = scorePredictions(REFERENCE_CORPUS, fromPredictor(perfect))

    expect(report.total).toBe(REFERENCE_CORPUS.length)
    expect(report.scored).toBe(REFERENCE_CORPUS.length * DECISION_TASK_IDS.length)
    expect(report.correct).toBe(report.scored)
    expect(report.incorrect).toBe(0)
    expect(report.unanswered).toBe(0)
    expect(report.accuracy).toBe(1)
    expect(report.invalidAnswers).toEqual([])
    expect(report.criticalFailures).toEqual([])
  })

  it('gives every task its own report, with totals that add up inside it', () => {
    const report = scorePredictions(REFERENCE_CORPUS, fromPredictor(perfect))

    for (const task of DECISION_TASK_IDS) {
      const taskReport = report.tasks[task]
      expect(taskReport.task).toBe(task)
      expect(taskReport.accuracy).toBe(1)
      expect(taskReport.scored).toBe(REFERENCE_CORPUS.length)
      expect(taskReport.correct).toBe(REFERENCE_CORPUS.length)
      expect(taskReport.incorrect).toBe(0)
      expect(taskReport.unanswered).toBe(0)
    }
  })

  it('reports the arithmetic of a wholly-wrong provider without rounding it away', () => {
    const report = scorePredictions(REFERENCE_CORPUS, fromPredictor(allWrong))

    expect(report.scored).toBe(REFERENCE_CORPUS.length * DECISION_TASK_IDS.length)
    expect(report.correct).toBe(0)
    expect(report.correct + report.incorrect).toBe(report.scored)
    expect(report.accuracy).toBe(0)
    for (const task of DECISION_TASK_IDS) {
      const taskReport = report.tasks[task]
      expect(taskReport.scored).toBe(REFERENCE_CORPUS.length)
      expect(taskReport.correct + taskReport.incorrect).toBe(taskReport.scored)
    }
  })

  it('counts the structured-truth-to-retrieval downgrade as critical, not as half-right', () => {
    // Every routing answer is "retrieval". The 26 genuine retrieval cases come
    // out right, the 25 live-state ones come out as unverified answers about
    // money and bookings, and accuracy is not the number that says so.
    const predictions = fromPredictor(perfect)
    for (const evaluationCase of REFERENCE_CORPUS)
      predictions[evaluationCase.id] = {
        ...perfect(evaluationCase),
        knowledge_routing: 'retrieval',
      }

    const report = scorePredictions(REFERENCE_CORPUS, predictions)
    const routing = report.tasks.knowledge_routing

    expect(routing.correct).toBe(26)
    expect(routing.incorrect).toBe(25)
    expect(routing.accuracy).toBeCloseTo(26 / 51, 12)
    expect(report.criticalFailures).toHaveLength(25)
    expect(report.criticalCapacity).toBe(25)
    expect(new Set(report.criticalFailures.map((failure) => failure.caseId)).size).toBe(25)
    for (const failure of report.criticalFailures) {
      expect(failure.expected).toBe('structured_truth')
      expect(failure.predicted).toBe('retrieval')
      expect(failure.kind).toBe('structured_truth_to_retrieval')
    }
  })

  it('does not count silence as a downgrade', () => {
    // A provider that declines every structured-truth question has failed to
    // answer twenty-five turns, which the report says as unanswered. It has not
    // produced a wrong answer, so the critical list stays empty.
    const predictions: Record<string, Predictions> = {}
    for (const evaluationCase of REFERENCE_CORPUS) {
      const rest: Predictions = { ...perfect(evaluationCase) }
      delete rest.knowledge_routing
      predictions[evaluationCase.id] = rest
    }

    const report = scorePredictions(REFERENCE_CORPUS, predictions)

    expect(report.tasks.knowledge_routing.scored).toBe(0)
    expect(report.tasks.knowledge_routing.unanswered).toBe(REFERENCE_CORPUS.length)
    expect(report.tasks.knowledge_routing.accuracy).toBe(0)
    expect(report.criticalFailures).toEqual([])
    expect(report.unanswered).toBe(REFERENCE_CORPUS.length)
  })

  it('counts an invented label as wrong and reports its vocabulary violation', () => {
    const predictions = fromPredictor(perfect)
    for (const evaluationCase of REFERENCE_CORPUS)
      predictions[evaluationCase.id] = {
        ...perfect(evaluationCase),
        intent_classification: 'vibes',
      }

    const report = scorePredictions(REFERENCE_CORPUS, predictions)

    expect(report.invalidAnswers).toHaveLength(REFERENCE_CORPUS.length)
    expect(report.invalidAnswers[0]).toMatchObject({
      task: 'intent_classification',
      predicted: 'vibes',
    })
    expect(report.tasks.intent_classification.correct).toBe(0)
    expect(report.tasks.intent_classification.scored).toBe(REFERENCE_CORPUS.length)
    expect(report.tasks.intent_classification.incorrect).toBe(REFERENCE_CORPUS.length)
    expect(report.criticalFailures).toEqual([])
  })

  it('keeps an out-of-vocabulary answer visible in the confusion row, so the miss is not hidden', () => {
    const evaluationCase = caseWith({
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
    })
    const report = scorePredictions([evaluationCase], {
      [evaluationCase.id]: { intent_classification: 'vibes' },
    })

    expect(report.invalidAnswers).toEqual([
      { caseId: 'c1', task: 'intent_classification', predicted: 'vibes' },
    ])
    expect(report.tasks.intent_classification.confusion['policy_inquiry']?.['vibes']).toBe(1)
    expect(report.tasks.intent_classification.correct).toBe(0)
  })

  it('does not score a task a case does not ask', () => {
    // Inventing an expected value for an unasked task would manufacture a miss.
    const evaluationCase = caseWith({
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
    })
    const report = scorePredictions([evaluationCase], {
      c1: { intent_classification: 'policy_inquiry', clarification: 'answer' },
    })

    expect(report.total).toBe(1)
    expect(report.scored).toBe(1)
    expect(report.tasks.clarification.scored).toBe(0)
    expect(report.tasks.clarification.unanswered).toBe(0)
    expect(report.tasks.clarification.accuracy).toBe(0)
  })

  it('treats a case with no predictions at all as unanswered, not as wrong', () => {
    const evaluationCase = caseWith({
      intent_classification: 'general_inquiry',
      knowledge_routing: 'retrieval',
    })
    const report = scorePredictions([evaluationCase], {})

    expect(report.total).toBe(1)
    expect(report.unanswered).toBe(2)
    expect(report.scored).toBe(0)
    expect(report.accuracy).toBe(0)
    expect(report.criticalFailures).toEqual([])
  })

  it('produces a confusion matrix over the whole vocabulary, in vocabulary order', () => {
    const report = scorePredictions(REFERENCE_CORPUS, fromPredictor(perfect))
    const confusion = report.tasks.knowledge_routing.confusion

    expect(Object.keys(confusion)).toEqual(['structured_truth', 'retrieval'])
    expect(Object.keys(confusion['structured_truth'] ?? {})).toEqual([
      'structured_truth',
      'retrieval',
    ])
    expect(confusion['structured_truth']?.['structured_truth']).toBe(25)
    expect(confusion['retrieval']?.['structured_truth']).toBe(0)
    expect(confusion['retrieval']?.['retrieval']).toBe(26)
  })

  it('counts per-label predictions, so a provider that only ever says one label is visible', () => {
    const predictions = fromPredictor(perfect)
    for (const evaluationCase of REFERENCE_CORPUS) {
      predictions[evaluationCase.id] = {
        ...perfect(evaluationCase),
        evidence_sufficiency: 'sufficient',
      }
    }

    const counts = scorePredictions(REFERENCE_CORPUS, predictions).tasks.evidence_sufficiency
      .predictedCounts
    expect(counts['sufficient']).toBe(REFERENCE_CORPUS.length)
    expect(counts['insufficient']).toBeUndefined()
  })

  it('survives an empty corpus without dividing by zero', () => {
    const report = scorePredictions([], {})

    expect(report.total).toBe(0)
    expect(report.scored).toBe(0)
    expect(report.accuracy).toBe(0)
    expect(report.tasks.knowledge_routing.accuracy).toBe(0)
    expect(formatReport(report)).toContain('critical failures: 0 of 0 at risk')
  })
})

describe('predictByCase', () => {
  it('agrees with scorePredictions on the same answers', async () => {
    const { report, predictions } = await predictByCase(REFERENCE_CORPUS, perfect)

    expect(report).toEqual(scorePredictions(REFERENCE_CORPUS, predictions))
    expect(report.accuracy).toBe(1)
  })

  it('accepts a promise-returning provider, so a live one can be scored later', async () => {
    // The shape a network-backed provider has: correct answers, a tick later.
    const networked: CasePredictor = async (evaluationCase) => {
      await Promise.resolve()
      return perfect(evaluationCase)
    }
    const { report } = await predictByCase(REFERENCE_CORPUS, networked)

    expect(report.correct).toBe(report.scored)
    expect(report.criticalFailures).toEqual([])
  })
})

describe('evaluate', () => {
  it('scores the reference corpus by default, so a caller cannot score a different one by accident', () => {
    const report = evaluate(fromPredictor(perfect))

    expect(report.total).toBe(REFERENCE_CORPUS.length)
    expect(report.criticalCapacity).toBe(25)
    expect(report.criticalFailures).toEqual([])
  })
})

describe('formatReport', () => {
  it('prints the numbers a human reads in CI, one line per task', () => {
    const predictions = fromPredictor(perfect)
    for (const evaluationCase of REFERENCE_CORPUS)
      predictions[evaluationCase.id] = {
        ...perfect(evaluationCase),
        knowledge_routing: 'retrieval',
      }

    const text = formatReport(scorePredictions(REFERENCE_CORPUS, predictions))

    expect(text).toContain('cases: 51')
    expect(text).toContain('critical failures: 25 of 25 at risk')
    expect(text).toContain('  knowledge_routing: ')
    expect(text).toContain('100.0%')
    expect(text).not.toContain('out-of-vocabulary predictions')
  })

  it('omits a task that was never asked, rather than printing a misleading zero', () => {
    const evaluationCase = caseWith({
      intent_classification: 'general_inquiry',
      knowledge_routing: 'retrieval',
    })
    const text = formatReport(scorePredictions([evaluationCase], { c1: perfect(evaluationCase) }))

    expect(text).toContain('100.0%')
    expect(text).toContain('  intent_classification: 100.0%')
    expect(text).not.toContain('  clarification:')
    expect(text).toContain('critical failures: 0 of 0 at risk')
  })
})
