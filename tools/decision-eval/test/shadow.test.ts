import { describe, expect, it } from 'vitest'
import type {
  Decision,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '@archava/adapters'
import { REFERENCE_CORPUS } from '../corpus.js'
import { parseLiveOptions } from '../live-options.js'
import { evaluateShadow, selectCases } from '../shadow.js'

function decision(question: DecisionQuestion): Decision {
  if (question.kind === 'boolean') {
    return { id: question.id, kind: 'boolean', answer: false, confidence: 0.95 }
  }
  if (question.kind === 'score') {
    return { id: question.id, kind: 'score', answer: 0.5, confidence: 0.95 }
  }
  return {
    id: question.id,
    kind: 'choice',
    answer:
      question.id === 'knowledge_routing' ? 'retrieval_knowledge' : (question.options?.[0] ?? ''),
    confidence: 0.95,
  }
}

function provider(mode: 'normal' | 'refuse' | 'throw' | 'malformed' = 'normal'): DecisionProvider {
  return {
    providerId: 'mock',
    model: 'mock-v1',
    health: { ready: true },
    decide(request: DecisionRequest): Promise<DecisionResult> {
      if (mode === 'throw') return Promise.reject(new Error('secret provider payload'))
      if (mode === 'refuse') {
        return Promise.resolve({
          providerId: 'mock',
          model: 'mock-v1',
          decisions: [],
          refused: request.questions.map((question) => ({
            id: question.id,
            reason: 'cannot answer',
          })),
        })
      }
      return Promise.resolve({
        providerId: 'mock',
        model: mode === 'malformed' ? 'wrong-model' : 'mock-v1',
        decisions: request.questions.map(decision),
        refused: [],
      })
    },
  }
}

const bookingStatus = REFERENCE_CORPUS.find((item) => item.id === 'en-booking-confirmed')
if (bookingStatus === undefined) throw new Error('The Foundation booking status case is missing.')

describe('optional Jev shadow evaluation', () => {
  it('requires an explicit live flag and server key', () => {
    expect(() => parseLiveOptions([], 'key')).toThrow('--live')
    expect(() => parseLiveOptions(['--live'], undefined)).toThrow('TYPESAFE_API_KEY')
    expect(() => parseLiveOptions(['--live', '--max-cases', '0'], 'key')).toThrow()
    expect(() => parseLiveOptions(['--live', '--pace-ms', '0'], 'key')).toThrow()
    expect(parseLiveOptions(['--live', '--max-cases', '3'], 'key')).toMatchObject({
      maxCases: 3,
      paceMs: 500,
    })
  })

  it('samples all three languages early and bounds the call count', () => {
    const selected = selectCases(REFERENCE_CORPUS, 3)
    expect(selected.map((item) => item.locale)).toEqual(['en', 'id', 'mixed'])
    expect(() => selectCases(REFERENCE_CORPUS, 52)).toThrow()
  })

  it('reports a raw routing downgrade while shadow keeps structured truth', async () => {
    const result = await evaluateShadow(provider(), { cases: [bookingStatus], maxCases: 1 })
    expect(result.providerCalls).toBe(1)
    expect(result.raw.criticalFailures).toHaveLength(1)
    expect(result.effective.criticalFailures).toHaveLength(0)
    expect(result.shadowChangedRuntime).toBe(false)
    expect(result.disagreements).toBeGreaterThan(0)
    expect(result.raw.tasks.evidence_sufficiency.scored).toBe(0)
    expect(result.raw.tasks.evidence_sufficiency.unanswered).toBe(0)
    expect(result.caseTraces).toContainEqual(
      expect.objectContaining({
        caseId: 'en-booking-confirmed',
        task: 'knowledge_routing',
        candidate: 'retrieval',
        effective: 'structured_truth',
        confidence: 0.95,
        disagreement: true,
      }),
    )
  })

  it('counts provider failures and refusals without changing runtime', async () => {
    const failed = await evaluateShadow(provider('throw'), { cases: [bookingStatus], maxCases: 1 })
    expect(failed.transportOrSchemaFailures).toBe(1)
    expect(failed.fallbacks).toBe(4)
    expect(failed.effective.criticalFailures).toHaveLength(0)
    const refused = await evaluateShadow(provider('refuse'), {
      cases: [bookingStatus],
      maxCases: 1,
    })
    expect(refused.refusals).toBe(4)
    expect(refused.transportOrSchemaFailures).toBe(0)
    const malformed = await evaluateShadow(provider('malformed'), {
      cases: [bookingStatus],
      maxCases: 1,
    })
    expect(malformed.transportOrSchemaFailures).toBe(1)
  })
})
