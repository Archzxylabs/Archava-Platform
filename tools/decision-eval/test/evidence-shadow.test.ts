import { describe, expect, it } from 'vitest'
import type {
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '@archava/adapters'
import { EVIDENCE_SET } from '../evidence-set.js'
import { evaluateEvidenceShadow, labelForScore, selectEvidenceCases } from '../evidence-shadow.js'

/**
 * A provider that answers one coverage score for every case: high by default,
 * low in `insufficient` mode, nothing in the refusal and failure modes, and in
 * `malformed` mode a reply whose model does not match the one it was asked
 * with — the same identity mismatch `shadow.test.ts` uses.
 */
function provider(mode: 'normal' | 'insufficient' | 'refuse' | 'throw' | 'malformed' = 'normal') {
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
          refused: request.questions.map((question: DecisionQuestion) => ({
            id: question.id,
            reason: 'cannot answer',
          })),
        })
      }
      const answer = mode === 'insufficient' ? 0.1 : 0.9
      return Promise.resolve({
        providerId: 'mock',
        model: mode === 'malformed' ? 'wrong-model' : 'mock-v1',
        decisions: request.questions.map((question) => ({
          id: question.id,
          kind: 'score',
          answer,
          confidence: 0.95,
        })),
        refused: [],
      })
    },
  } satisfies DecisionProvider
}

const sufficientCase = EVIDENCE_SET.find((item) => item.expected === 'sufficient')
const missingCase = EVIDENCE_SET.find((item) => item.hazard === 'missing')
const overlapCase = EVIDENCE_SET.find(
  (item) => item.hazard === 'overlap' && item.expected === 'insufficient',
)
const liveCase = EVIDENCE_SET.find((item) => item.hazard === 'protected_truth')

if (
  sufficientCase === undefined ||
  missingCase === undefined ||
  overlapCase === undefined ||
  liveCase === undefined
) {
  throw new Error('the evidence set is missing a case one of these tests needs')
}

/** The three cases every run below uses: one of each kind of judgement. */
const SAMPLE = [sufficientCase, overlapCase, liveCase]

describe('evidence-sufficiency SHADOW evaluation', () => {
  it('maps a coverage score to the label the runtime uses', () => {
    expect(labelForScore(0.5)).toBe('sufficient')
    expect(labelForScore(0.49)).toBe('insufficient')
    expect(labelForScore(1)).toBe('sufficient')
    expect(labelForScore(0)).toBe('insufficient')
  })

  it('spreads a nine-case run across hazards and both labels', () => {
    const selected = selectEvidenceCases(EVIDENCE_SET, 9)
    expect(selected.map((item) => item.locale)).toEqual([
      'en',
      'id',
      'mixed',
      'en',
      'id',
      'mixed',
      'en',
      'id',
      'mixed',
    ])
    // Not nine English `supported` cases: a short run walks hazards in order,
    // so every language is measured on supplied facts, on nothing supplied, and
    // on copy that overlaps the subject without asserting the answer.
    expect(selected.map((item) => item.hazard)).toEqual([
      'supported',
      'supported',
      'supported',
      'missing',
      'missing',
      'missing',
      'overlap',
      'overlap',
      'overlap',
    ])
    for (const locale of ['en', 'id', 'mixed'] as const) {
      const inLocale = selected.filter((item) => item.locale === locale)
      expect(inLocale.map((item) => item.expected)).toEqual([
        'sufficient',
        'insufficient',
        'insufficient',
      ])
    }
    expect(() => selectEvidenceCases(EVIDENCE_SET, EVIDENCE_SET.length + 1)).toThrow()
    expect(() => selectEvidenceCases(EVIDENCE_SET, 0)).toThrow()
  })

  it('writes one provider call per case and changes nothing', async () => {
    const result = await evaluateEvidenceShadow(provider(), { cases: SAMPLE, maxCases: 3 })
    expect(result.providerCalls).toBe(3)
    expect(result.shadowChangedRuntime).toBe(false)
    // The provider answered high for all three. One of them is right because the
    // excerpt really does answer it; the other two are wrong and neither answer
    // reached a turn, because SHADOW holds the effective answer at the baseline.
    // Every case in this trio came back with an excerpt, so the presence floor
    // says sufficient to all three — and is right exactly once. The provider's
    // own answer is scored separately and never becomes the effective one.
    expect(result.raw.correct).toBe(1)
    expect(result.raw.incorrect).toBe(2)
    expect(result.effective.correct).toBe(1)
    expect(result.effective.incorrect).toBe(2)
    for (const trace of result.evidenceTraces) {
      expect(trace.wouldApply).toBe(true)
      expect(trace.effective).toBe('sufficient')
    }
  })

  it('accepts sufficient evidence and refuses every insufficient kind', async () => {
    const result = await evaluateEvidenceShadow(provider(), { cases: SAMPLE, maxCases: 3 })
    expect(result.raw.correct).toBe(1)
    expect(result.raw.incorrect).toBe(2)
    expect(result.raw.protectedTruthAtRisk).toBe(1)
    // Two cases called sufficient that are not, each named with its cause.
    expect(result.raw.unsupportedSufficientCount).toBe(2)
    expect(result.raw.unsupportedSufficient).toEqual([
      expect.objectContaining({ caseId: overlapCase.id, hazard: 'overlap', liveSubject: null }),
      expect.objectContaining({
        caseId: liveCase.id,
        hazard: 'protected_truth',
        liveSubject: liveCase.liveSubject,
      }),
    ])
  })

  it('scores the deterministic baseline beside the provider, not instead of it', async () => {
    const result = await evaluateEvidenceShadow(provider(), { cases: SAMPLE, maxCases: 3 })
    // The baseline answers from presence alone: anything with an excerpt earns
    // sufficient. That is right on `supported`, wrong on the two traps, and
    // would score the identical trio by never judging anything — which is why
    // the provider score is reported alongside it and read first.
    expect(result.effective.correct).toBe(1)
    expect(result.effective.incorrect).toBe(2)
    expect(result.raw.accuracy).toBeCloseTo(1 / 3)

    // An optimistic provider claiming sufficient over an empty turn is the
    // disagreement the count exists to name: it answered where the floor
    // correctly said there was nothing to answer from.
    const invented = await evaluateEvidenceShadow(provider(), { cases: [missingCase], maxCases: 1 })
    expect(invented.raw.incorrect).toBe(1)
    expect(invented.raw.unsupportedSufficientCount).toBe(1)
    expect(invented.effective.correct).toBe(1)
    expect(invented.disagreements).toBe(1)
    expect(invented.evidenceTraces[0]?.disagreement).toBe(true)

    // A provider that reads the empty turn correctly agrees with the floor.
    const empty = await evaluateEvidenceShadow(provider('insufficient'), {
      cases: [missingCase],
      maxCases: 1,
    })
    expect(empty.raw.correct).toBe(1)
    expect(empty.effective.correct).toBe(1)
    expect(empty.disagreements).toBe(0)

    // The valuable reverse direction also counts: a provider notices that an
    // overlapping page does not answer the question the presence floor missed.
    const cautious = await evaluateEvidenceShadow(provider('insufficient'), {
      cases: [overlapCase],
      maxCases: 1,
    })
    expect(cautious.raw.correct).toBe(1)
    expect(cautious.effective.incorrect).toBe(1)
    expect(cautious.disagreements).toBe(1)
    expect(cautious.evidenceTraces[0]?.disagreement).toBe(true)
  })

  it('counts refusals, transport failures and malformed replies without moving a turn', async () => {
    const refused = await evaluateEvidenceShadow(provider('refuse'), {
      cases: [sufficientCase],
      maxCases: 1,
    })
    expect(refused.refusals).toBe(1)
    expect(refused.providerCalls).toBe(1)
    expect(refused.raw.unanswered).toBe(1)
    expect(refused.raw.unsupportedSufficientCount).toBe(0)
    expect(refused.shadowChangedRuntime).toBe(false)

    const failed = await evaluateEvidenceShadow(provider('throw'), {
      cases: [sufficientCase],
      maxCases: 1,
    })
    expect(failed.transportOrSchemaFailures).toBe(1)
    expect(failed.fallbacks).toBe(1)
    expect(failed.raw.unanswered).toBe(1)

    const malformed = await evaluateEvidenceShadow(provider('malformed'), {
      cases: [sufficientCase],
      maxCases: 1,
    })
    expect(malformed.malformed).toBe(1)
    expect(malformed.transportOrSchemaFailures).toBe(0)
    expect(malformed.raw.scored).toBe(0)
    expect(malformed.raw.unanswered).toBe(1)
  })

  it('reports per-locale accuracy rather than one pooled average', async () => {
    const result = await evaluateEvidenceShadow(provider(), { maxCases: 9 })
    expect(result.casesRun).toBe(9)
    expect(result.languages).toEqual({ en: 3, id: 3, mixed: 3 })
    for (const locale of ['en', 'id', 'mixed'] as const) {
      const report = result.raw.locales[locale]
      expect(report.total).toBe(3)
      expect(report.labels.sufficient.scored).toBe(1)
      expect(report.labels.insufficient.scored).toBe(2)
    }
  })
})
