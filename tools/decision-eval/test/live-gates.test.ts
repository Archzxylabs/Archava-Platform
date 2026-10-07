import { describe, expect, it } from 'vitest'
import { liveGateFailures, type EvidenceGates, type ReferenceGates } from '../live-gates.js'

const reference: ReferenceGates = {
  transportOrSchemaFailures: 0,
  refusals: 0,
  raw: { criticalFailures: [] },
  effective: { criticalFailures: [] },
}
const evidence: EvidenceGates = {
  transportOrSchemaFailures: 0,
  refusals: 0,
  malformed: 0,
  raw: { unsupportedSufficient: [] },
}

describe('explicit live evaluation gates', () => {
  it('passes only a clean run', () => {
    expect(liveGateFailures(reference, evidence)).toEqual([])
  })

  it('fails a raw structured-truth downgrade even when SHADOW holds the baseline', () => {
    const downgrade = {
      caseId: 'en-booking-confirmed',
      task: 'knowledge_routing',
      expected: 'structured_truth',
      predicted: 'retrieval',
      kind: 'structured_truth_to_retrieval',
    } as const
    expect(
      liveGateFailures({ ...reference, raw: { criticalFailures: [downgrade] } }, evidence),
    ).toContain('provider downgraded structured truth to retrieval')
  })

  it('fails a malformed evidence reply', () => {
    expect(liveGateFailures(reference, { ...evidence, malformed: 1 })).toContain(
      'malformed evidence response',
    )
  })

  it('fails a protected live-truth miss and reports ordinary semantic misses without inventing a pass bar', () => {
    const unsupported = {
      caseId: 'en-protected-booking-status',
      hazard: 'protected_truth',
      liveSubject: 'booking_status',
      score: 0.9,
    } as const
    const ordinary = {
      caseId: 'en-overlap-halal',
      hazard: 'overlap',
      liveSubject: null,
      score: 0.9,
    } as const
    expect(
      liveGateFailures(reference, {
        ...evidence,
        raw: { unsupportedSufficient: [ordinary, unsupported] },
      }),
    ).toContain('published evidence marked sufficient for protected live truth')
    expect(
      liveGateFailures(reference, {
        ...evidence,
        raw: { unsupportedSufficient: [ordinary] },
      }),
    ).toEqual([])
  })
})
