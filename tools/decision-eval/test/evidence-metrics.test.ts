import { describe, expect, it } from 'vitest'
import { EVIDENCE_SET } from '../evidence-set.js'
import {
  formatEvidenceReport,
  scoreEvidencePredictions,
  type EvidencePredictions,
} from '../evidence-metrics.js'

/** Score by label, with an override for the case under test. */
function scoreFor(
  cases: readonly { id: string; expected: string }[],
  overrides: EvidencePredictions = {},
): EvidencePredictions {
  const predictions: Record<string, { label: string; score: number | null }> = {}
  for (const item of cases) {
    predictions[item.id] = {
      label: item.expected,
      score: item.expected === 'sufficient' ? 0.9 : 0.1,
    }
  }
  return { ...predictions, ...overrides }
}

/** One real case, guarded once so every test below can name it. */
const FIRST = EVIDENCE_SET[0]
if (FIRST === undefined) throw new Error('the evidence set is empty')

describe('evidence-sufficiency metrics', () => {
  const cases = EVIDENCE_SET

  it('scores every case for a provider that gets all of them right', () => {
    const report = scoreEvidencePredictions(cases, scoreFor(cases))
    expect(report.total).toBe(cases.length)
    expect(report.scored).toBe(cases.length)
    expect(report.unanswered).toBe(0)
    expect(report.accuracy).toBe(1)
    expect(report.unsupportedSufficientCount).toBe(0)
  })

  it('counts a missing prediction as unanswered, not as wrong', () => {
    const predictions = scoreFor(cases)
    const withoutFirst: Record<string, { label: string; score: number | null }> = { ...predictions }
    delete withoutFirst[FIRST.id]
    const report = scoreEvidencePredictions(cases, withoutFirst)
    expect(report.unanswered).toBe(1)
    expect(report.incorrect).toBe(0)
    expect(report.accuracy).toBe((cases.length - 1) / cases.length)
  })

  it('counts an out-of-vocabulary answer as unanswered in the accuracy denominator', () => {
    const report = scoreEvidencePredictions(cases, {
      ...scoreFor(cases),
      [FIRST.id]: { label: 'the evidence seems adequate', score: 0.7 },
    })
    expect(report.invalidAnswers).toEqual([
      expect.objectContaining({ caseId: FIRST.id, predicted: 'the evidence seems adequate' }),
    ])
    expect(report.scored).toBe(cases.length - 1)
    expect(report.total).toBe(report.scored + report.unanswered)
    expect(report.unanswered).toBe(1)
    expect(report.correct).toBe(report.scored)
    expect(report.incorrect).toBe(0)
    expect(report.accuracy).toBe((cases.length - 1) / cases.length)
    expect(report.locales[FIRST.locale].unanswered).toBe(1)
    expect(report.hazards[FIRST.hazard].unanswered).toBe(1)
  })

  it('separates hazards so one number cannot hide which kind failed', () => {
    // A provider that believes nothing but its own optimism: sufficient answer,
    // insufficient label, every time an excerpt is present.
    const report = scoreEvidencePredictions(cases, {
      ...scoreFor(cases),
      ...Object.fromEntries(
        cases
          .filter((item) => item.expected === 'insufficient')
          .map((item) => [item.id, { label: 'sufficient', score: 0.9 }]),
      ),
    })
    expect(report.hazards.supported.scored).toBeGreaterThan(0)
    expect(report.hazards.supported.correct).toBe(report.hazards.supported.scored)
    expect(report.hazards.overlap.correct).toBe(0)
    expect(report.hazards.overlap.incorrect).toBeGreaterThan(0)
    expect(report.unsupportedSufficientCount).toBe(
      Object.values(report.hazards).reduce((sum, hazard) => sum + hazard.incorrect, 0),
    )
  })

  it('reports every locale separately, with both labels inside each', () => {
    const report = scoreEvidencePredictions(cases, scoreFor(cases))
    for (const locale of ['en', 'id', 'mixed'] as const) {
      expect(report.locales[locale].total).toBeGreaterThan(0)
      expect(report.locales[locale].labels.sufficient.scored).toBeGreaterThan(0)
      expect(report.locales[locale].labels.insufficient.scored).toBeGreaterThan(0)
      expect(report.locales[locale].accuracy).toBe(1)
    }
  })

  it('reports a live-authority miss with the subject that owns the fact', () => {
    const live = cases.find((item) => item.liveSubject !== null)
    if (live === undefined) throw new Error('the set has no live-authority case')
    const report = scoreEvidencePredictions(cases, {
      ...scoreFor(cases),
      [live.id]: { label: 'sufficient', score: 0.88 },
    })
    expect(report.unsupportedSufficient).toContainEqual(
      expect.objectContaining({
        caseId: live.id,
        hazard: 'protected_truth',
        liveSubject: live.liveSubject,
      }),
    )
    const text = formatEvidenceReport(report)
    expect(text).toContain(live.id)
    expect(text).toContain(`live ${live.liveSubject}`)
  })

  it('names the count that matters even when nothing failed', () => {
    const clean = scoreEvidencePredictions(cases, scoreFor(cases))
    expect(clean.protectedTruthAtRisk).toBeGreaterThan(0)
    expect(formatEvidenceReport(clean)).toContain('unsupported facts treated as sufficient: 0')
  })
})
