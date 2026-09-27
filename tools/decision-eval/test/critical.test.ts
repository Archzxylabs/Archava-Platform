/**
 * Critical-failure tests.
 *
 * The rule gets its own tests because accuracy alone cannot express it. Under a
 * per-label average, a provider that routes ten structured-truth questions to
 * retrieval and gets ten retrieval questions right reads as 50%, which is
 * not what happened: it produced ten unverified answers about money, bookings
 * and availability. PRD §17 forbids that downgrade outright, so it is counted
 * separately and asserted here as a boundary rather than as a proportion.
 */

import { describe, expect, it } from 'vitest'

import {
  CRITICAL_FAILURE_KINDS,
  RETRIEVAL,
  ROUTING_TASK,
  STRUCTURED_TRUTH,
  criticalCapacity,
  findCriticalFailures,
  isCriticalDowngrade,
  type ScoredAnswer,
} from '../critical.js'
import { REFERENCE_CORPUS } from '../corpus.js'

function answer(
  task: ScoredAnswer['task'],
  expected: string,
  predicted: string,
  caseId = 'c1',
): ScoredAnswer {
  return { caseId, task, expected, predicted }
}

describe('isCriticalDowngrade', () => {
  it('is true for the one forbidden transition', () => {
    expect(isCriticalDowngrade(ROUTING_TASK, STRUCTURED_TRUTH, RETRIEVAL)).toBe(true)
  })

  it('is false for the reverse, which costs money but not correctness', () => {
    // Sending a retrieval question to live systems answers the visitor from
    // published knowledge anyway; the failure is cost, not a wrong fact.
    expect(isCriticalDowngrade(ROUTING_TASK, RETRIEVAL, STRUCTURED_TRUTH)).toBe(false)
  })

  it('is false for every other task, whatever the labels', () => {
    for (const task of [
      'intent_classification',
      'clarification',
      'handoff_recommendation',
      'evidence_sufficiency',
    ] as const) {
      expect(isCriticalDowngrade(task, STRUCTURED_TRUTH, RETRIEVAL), task).toBe(false)
    }
  })

  it('is false for an unknown prediction, which is a bug but not a downgrade', () => {
    // A label outside the task's vocabulary cannot be shown to have replaced
    // structured truth with retrieval, so it must not trip the counter.
    expect(isCriticalDowngrade(ROUTING_TASK, STRUCTURED_TRUTH, 'something_else')).toBe(false)
  })

  it('is false when structured truth was kept', () => {
    expect(isCriticalDowngrade(ROUTING_TASK, STRUCTURED_TRUTH, STRUCTURED_TRUTH)).toBe(false)
  })
})

describe('findCriticalFailures', () => {
  it('collects every downgrade and names the case, so a report is actionable', () => {
    const failures = findCriticalFailures([
      answer('intent_classification', 'pricing_inquiry', 'pricing_inquiry', 'ok-1'),
      answer(ROUTING_TASK, STRUCTURED_TRUTH, RETRIEVAL, 'bad-1'),
      answer(ROUTING_TASK, STRUCTURED_TRUTH, STRUCTURED_TRUTH, 'good-1'),
      answer(ROUTING_TASK, RETRIEVAL, RETRIEVAL, 'good-2'),
      answer(ROUTING_TASK, STRUCTURED_TRUTH, RETRIEVAL, 'bad-2'),
    ])

    expect(failures).toHaveLength(2)
    expect(failures.map((failure) => failure.caseId)).toEqual(['bad-1', 'bad-2'])
    expect(failures[0]).toEqual({
      caseId: 'bad-1',
      task: ROUTING_TASK,
      expected: STRUCTURED_TRUTH,
      predicted: RETRIEVAL,
      kind: 'structured_truth_to_retrieval',
    })
  })

  it('reports kind from the published list, not an ad-hoc string', () => {
    const [failure] = findCriticalFailures([answer(ROUTING_TASK, STRUCTURED_TRUTH, RETRIEVAL)])
    expect(CRITICAL_FAILURE_KINDS).toContain(failure?.kind)
  })

  it('reports nothing for an empty run', () => {
    expect(findCriticalFailures([])).toEqual([])
  })
})

describe('criticalCapacity', () => {
  it('counts the cases that could expose a downgrade', () => {
    const capacity = criticalCapacity([
      { expected: { knowledge_routing: STRUCTURED_TRUTH } },
      { expected: { knowledge_routing: RETRIEVAL } },
      { expected: { intent_classification: 'policy_inquiry' } },
      { expected: { knowledge_routing: STRUCTURED_TRUTH } },
    ])
    expect(capacity).toBe(2)
  })

  it('is a comfortable number for the reference corpus, so a zero is informative', () => {
    // A corpus with no structured-truth case would let a provider that never
    // routes correctly report zero critical failures and look perfect.
    expect(criticalCapacity(REFERENCE_CORPUS)).toBe(25)
    expect(criticalCapacity(REFERENCE_CORPUS)).toBeGreaterThan(REFERENCE_CORPUS.length / 3)
  })
})
