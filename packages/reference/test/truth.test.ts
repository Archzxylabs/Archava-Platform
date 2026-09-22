import { describe, expect, it } from 'vitest'
import type { StructuredTruthSubject } from '@archava/knowledge'
import {
  TRUTH_SUBJECTS_ANSWERED,
  UNANSWERED_SUBJECTS,
  REFERENCE_CURRENCY,
  referenceTruth,
} from '../src/index.js'

/**
 * PRD §17 draws the line this package is organised around: price, stock and
 * availability come from a live system, never from stale vector retrieval.
 *
 * The port's record holds exactly what it was asked about, and what it does not
 * own is absent from the record rather than answered with a shrug. That absence
 * is load-bearing: `resolveTruth` treats a non-empty record as authoritative and
 * an empty one as unanswered, which is what makes an honest "I can't see that"
 * reachable at all.
 */
describe('referenceTruth port', () => {
  it('answers the subjects a resort would own', () => {
    expect([...TRUTH_SUBJECTS_ANSWERED].sort()).toEqual(['availability', 'price', 'stock'])
    expect(Object.keys(referenceTruth.resolve(TRUTH_SUBJECTS_ANSWERED)).sort()).toEqual([
      'availability',
      'price',
      'stock',
    ])
  })

  it('says nothing about a subject it does not own', () => {
    // A port sees subject names only — never the utterance — so answering "my
    // booking" from a shared fixture would hand every visitor the demo's own
    // reference codes. Absence is the honest answer, not a failure.
    for (const subject of UNANSWERED_SUBJECTS) {
      expect(Object.keys(referenceTruth.resolve([subject])), `"${subject}" was answered`).toEqual(
        [],
      )
    }
    expect(Object.keys(referenceTruth.resolve(UNANSWERED_SUBJECTS))).toEqual([])
  })

  it('answers each subject independently, so asking for one does not imply the others', () => {
    expect(Object.keys(referenceTruth.resolve(['price']))).toEqual(['price'])
    expect(Object.keys(referenceTruth.resolve(['stock']))).toEqual(['stock'])
    expect(Object.keys(referenceTruth.resolve(['availability']))).toEqual(['availability'])
  })

  it('quotes the same prices the fixtures state, rather than restating them', () => {
    const price = referenceTruth.resolve(['price']).price as {
      currency: string
      nights: ReadonlyArray<{ unitId: string; night: string; amountMinor: number }>
      weekendUpliftPercent: number
    }
    expect(price.currency).toBe(REFERENCE_CURRENCY)
    expect(price.weekendUpliftPercent).toBeGreaterThan(0)
    // The rounded-up tie: the demo's own number, checked through the port.
    const deluxe = price.nights.find(
      (night) => night.unitId === 'deluxe-valley' && night.night === '2026-10-09',
    )
    expect(deluxe?.amountMinor).toBe(1_438_000)
    // Four units across all six nights, not a sample.
    expect(price.nights).toHaveLength(24)
  })

  it('reports availability for the window it sells, so the port can be shown to a visitor', () => {
    const availability = referenceTruth.resolve(['availability']).availability as {
      bookable: ReadonlyArray<{ unitId: string }>
    }
    expect(availability.bookable.map((stay) => stay.unitId)).toEqual(['deluxe-valley'])
  })

  it('reports how many rooms of each type the resort actually has', () => {
    const stock = referenceTruth.resolve(['stock']).stock as {
      units: ReadonlyArray<{ unitId: string; roomsBuilt: number }>
    }
    expect(Object.fromEntries(stock.units.map((unit) => [unit.unitId, unit.roomsBuilt]))).toEqual({
      'garden-twin': 4,
      'deluxe-valley': 6,
      'treetop-suite': 2,
      'valley-pool-villa': 2,
    })
  })

  it('leaves a requested-but-unowned subject absent, so the §27 gap still fires', () => {
    const mixed: readonly StructuredTruthSubject[] = ['price', 'booking_status']
    // Non-empty, so authoritative for what it holds — silent on what it does
    // not, so the gap is still reported rather than papered over.
    expect(Object.keys(referenceTruth.resolve(mixed))).toEqual(['price'])
  })
})
