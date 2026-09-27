import { describe, expect, it } from 'vitest'
import { REFERENCE_CORPUS } from '../corpus.js'
import {
  EVIDENCE_LABELS,
  EVIDENCE_SET,
  EVIDENCE_SET_SIZE,
  evidenceRequest,
  evidenceSetProblems,
  isEvidenceLabel,
  labelForHazard,
} from '../evidence-set.js'

describe('labelled evidence-sufficiency set', () => {
  it('is separate from the 51 utterance-only cases', () => {
    const utteranceIds = new Set(REFERENCE_CORPUS.map((item) => item.id))
    const evidenceIds = new Set(EVIDENCE_SET.map((item) => item.id))
    expect(EVIDENCE_SET.length).toBe(EVIDENCE_SET_SIZE)
    expect([...evidenceIds].filter((id) => utteranceIds.has(id))).toEqual([])
  })

  it('carries every label in every language in usable supply', () => {
    for (const locale of ['en', 'id', 'mixed'] as const) {
      const inLocale = EVIDENCE_SET.filter((item) => item.locale === locale)
      for (const label of EVIDENCE_LABELS) {
        expect(inLocale.filter((item) => item.expected === label).length).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('never lets retrieval be authority over a live subject', () => {
    // These are the cases a provider must not answer from published copy: the
    // tenant's live system owns the fact, and copy about it is only a claim.
    const live = EVIDENCE_SET.filter((item) => item.liveSubject !== null)
    expect(live.length).toBeGreaterThanOrEqual(3)
    for (const item of live) {
      expect(item.expected).toBe('insufficient')
      expect(item.hazard).toBe('protected_truth')
      // The tempting copy has to be present — a case with nothing to read would
      // refuse for the wrong reason — and it must never state the live fact.
      expect(item.excerpts.length).toBeGreaterThan(0)
      const said = item.excerpts.map((excerpt) => excerpt.text.toLowerCase()).join(' ')
      expect(said).not.toContain('is confirmed')
      expect(said).not.toContain('sudah lunas')
      expect(said).not.toContain('is available tonight')
      expect(said).not.toContain('the price is')
    }
  })

  it('carries no problem the validator can name', () => {
    // The single strongest assertion here: the same sentences the harness would
    // print about a set that stopped being able to measure anything.
    expect(evidenceSetProblems(EVIDENCE_SET)).toEqual([])
  })

  it('stays structurally valid and explains itself in one sentence', () => {
    for (const item of EVIDENCE_SET) {
      expect(isEvidenceLabel(item.expected)).toBe(true)
      expect(item.expected).toBe(labelForHazard(item.hazard))
      expect(item.why.trim()).toBe(item.why)
      expect(item.why.length).toBeGreaterThan(20)
      expect(item.question.trim()).toBe(item.question)
      expect(item.question.length).toBeGreaterThan(10)
      if (item.expected === 'sufficient') expect(item.excerpts.length).toBeGreaterThan(0)
      if (item.hazard === 'missing') expect(item.excerpts).toHaveLength(0)
      expect(new Set(item.excerpts.map((excerpt) => excerpt.sourceId)).size).toBe(
        item.excerpts.length,
      )
    }
  })

  it('keeps the question bounded and the projected evidence faithful', () => {
    for (const item of EVIDENCE_SET) {
      const projected = evidenceRequest(item)
      expect(projected.page).toMatchObject({ kind: 'synthetic-evidence' })
      expect(projected.publishedEvidence).toHaveLength(item.excerpts.length)
      expect(projected.publishedEvidence?.map((excerpt) => excerpt.sourceId)).toEqual(
        item.excerpts.map((excerpt) => excerpt.sourceId),
      )
    }
  })

  it('exposes semantic overlap without factual support', () => {
    // Breakfast mentioned, halal certification asked: the trap is that a shared
    // topic is not a stated fact. A provider scoring overlap as coverage fails
    // these, which is exactly why they exist.
    const overlap = EVIDENCE_SET.filter((item) => item.hazard === 'overlap')
    expect(overlap.length).toBeGreaterThanOrEqual(6)
    for (const item of overlap) {
      expect(item.expected).toBe('insufficient')
      const text = item.excerpts.map((excerpt) => excerpt.text.toLowerCase()).join(' ')
      // The excerpts talk around the subject area...
      expect(text.length).toBeGreaterThan(20)
      // ...and never assert the specific thing asked about.
      expect(text).not.toContain('halal certified')
      expect(text).not.toContain('certified halal')
    }
  })
})
