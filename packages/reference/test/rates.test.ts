import { describe, expect, it } from 'vitest'
import {
  REFERENCE_NIGHTS,
  REFERENCE_TAX,
  REFERENCE_WINDOW,
  WEEKEND_UPLIFT_PERCENT,
  baseRate,
  bookableStays,
  cheapestBookable,
  isReferenceNight,
  isWeekendNight,
  nightlyAvailability,
  nightlyRate,
  nightsBetween,
  referenceUnits,
  roomsBuilt,
  stayAvailability,
  stayQuote,
} from '../src/index.js'

/**
 * These fixtures are the demo's only pricing authority (PRD §17), so these
 * assertions are the contract a live PMS adapter would have to honour — not a
 * description of the current numbers.
 */
describe('rates', () => {
  describe('nightlyRate', () => {
    it('charges the base rate on a weeknight', () => {
      expect(nightlyRate('garden-twin', '2026-10-05')).toEqual({
        unitId: 'garden-twin',
        night: '2026-10-05',
        amountMinor: 850_000,
        currency: 'IDR',
      })
    })

    it(`applies the ${WEEKEND_UPLIFT_PERCENT}% uplift on the stated weekend nights`, () => {
      // 2026-10-05 is a Monday, so the 9th and 10th are the weekend nights, and
      // the tie at 1,437,500 must round the same way for every unit.
      expect(nightlyRate('garden-twin', '2026-10-09')?.amountMinor).toBe(978_000)
      expect(nightlyRate('deluxe-valley', '2026-10-09')?.amountMinor).toBe(1_438_000)
      expect(nightlyRate('treetop-suite', '2026-10-10')?.amountMinor).toBe(2_415_000)
      expect(isWeekendNight('2026-10-09')).toBe(true)
      expect(isWeekendNight('2026-10-10')).toBe(true)
      expect(isWeekendNight('2026-10-08')).toBe(false)
      // The checkout date is a bound, not a night.
      expect(isWeekendNight('2026-10-11')).toBe(false)
    })

    it('prices every unit it claims to own', () => {
      for (const unit of referenceUnits) {
        expect(baseRate(unit.id)).toBeGreaterThan(0)
        expect(roomsBuilt(unit.id)).toBeGreaterThan(0)
      }
    })

    it('has no rate for a unit it does not own or a night outside the fixtures', () => {
      expect(nightlyRate('penthouse-lodge', '2026-10-05')).toBeUndefined()
      expect(nightlyRate('garden-twin', '2026-10-04')).toBeUndefined()
      expect(nightlyRate('garden-twin', '2026-10-11')).toBeUndefined()
    })
  })

  describe('nightlyAvailability', () => {
    it('reports every room as sellable on a plain night', () => {
      expect(nightlyAvailability('treetop-suite', '2026-10-05')).toEqual({
        unitId: 'treetop-suite',
        night: '2026-10-05',
        available: true,
        unitsLeft: 2,
      })
    })

    it('closes a unit on the nights it is held', () => {
      // The garden wing is closed for a wedding party across two nights.
      expect(nightlyAvailability('garden-twin', '2026-10-08')).toEqual({
        unitId: 'garden-twin',
        night: '2026-10-08',
        available: false,
        unitsLeft: 0,
      })
      expect(nightlyAvailability('garden-twin', '2026-10-09')?.available).toBe(false)
      // A closed night reads the same from a stay that spans it.
      expect(stayAvailability('garden-twin', '2026-10-07', '2026-10-10')?.everyNightAvailable).toBe(
        false,
      )
    })

    it('leaves a remainder rather than closing, when a group has taken most of a type', () => {
      // The interesting demo case: sellable, but not "plenty available".
      expect(nightlyAvailability('deluxe-valley', '2026-10-09')).toEqual({
        unitId: 'deluxe-valley',
        night: '2026-10-09',
        available: true,
        unitsLeft: 2,
      })
    })
  })

  describe('nightsBetween', () => {
    it('covers the check-in night through the night before checkout', () => {
      expect(nightsBetween('2026-10-05', '2026-10-11')).toEqual([...REFERENCE_NIGHTS])
      expect(nightsBetween('2026-10-07', '2026-10-09')).toEqual(['2026-10-07', '2026-10-08'])
    })

    it('refuses a window reaching past the fixtures rather than extrapolating', () => {
      expect(nightsBetween('2026-10-05', '2026-10-12')).toEqual([])
      expect(nightsBetween('2026-10-04', '2026-10-11')).toEqual([])
      // An empty or inverted stay is not a one-night stay.
      expect(nightsBetween('2026-10-08', '2026-10-08')).toEqual([])
      expect(nightsBetween('2026-10-10', '2026-10-05')).toEqual([])
      // Nothing can be booked *on* the checkout date.
      expect(nightsBetween('2026-10-11', '2026-10-12')).toEqual([])
    })

    it('agrees with the window the fixtures declare', () => {
      expect(REFERENCE_WINDOW.from).toBe('2026-10-05')
      expect(REFERENCE_WINDOW.to).toBe('2026-10-11')
      for (const night of REFERENCE_NIGHTS) {
        expect(isReferenceNight(night)).toBe(true)
      }
      expect(isReferenceNight('2026-10-11')).toBe(false)
    })
  })

  describe('stayQuote', () => {
    it('totals a whole stay, tax line included', () => {
      const quote = stayQuote('deluxe-valley', '2026-10-05', '2026-10-11')
      expect(quote).toMatchObject({
        unitId: 'deluxe-valley',
        subtotalMinor: 7_876_000,
        taxMinor: 866_360,
        totalMinor: 8_742_360,
        currency: 'IDR',
      })
      expect(quote?.nights).toHaveLength(REFERENCE_NIGHTS.length)
      expect(quote?.nights.map((night) => night.amountMinor)).toEqual([
        1_250_000, 1_250_000, 1_250_000, 1_250_000, 1_438_000, 1_438_000,
      ])
    })

    it('states the tax it applied, so the total can be explained', () => {
      const quote = stayQuote('garden-twin', '2026-10-05', '2026-10-07')
      expect(REFERENCE_TAX).toEqual({ code: 'PPN', label: 'PPN 11%', ratePercent: 11 })
      expect(quote?.subtotalMinor).toBe(1_700_000)
      expect(quote?.taxMinor).toBe(187_000)
      expect(quote?.totalMinor).toBe(1_887_000)
    })

    it('quotes a stay it cannot sell, because the price is still a real question', () => {
      // The garden twin is closed across the 8th and 9th, yet a visitor may
      // still ask what it would cost. `undefined` here would be a wrong answer.
      const quote = stayQuote('garden-twin', REFERENCE_WINDOW.from, REFERENCE_WINDOW.to)
      expect(quote?.totalMinor).toBe(5_945_160)
      expect(
        stayAvailability('garden-twin', REFERENCE_WINDOW.from, REFERENCE_WINDOW.to)
          ?.everyNightAvailable,
      ).toBe(false)
    })

    it('returns nothing for a window the fixtures do not cover', () => {
      expect(stayQuote('garden-twin', '2026-10-05', '2026-10-20')).toBeUndefined()
      expect(stayQuote('penthouse-lodge', '2026-10-05', '2026-10-11')).toBeUndefined()
    })
  })

  describe('bookableStays', () => {
    it('offers only the units sellable across every night of the stay', () => {
      // Each of the other three is closed somewhere inside the window, so the
      // demo's canonical stay has exactly one genuinely bookable unit.
      expect(
        bookableStays(REFERENCE_WINDOW.from, REFERENCE_WINDOW.to).map((stay) => stay.unitId),
      ).toEqual(['deluxe-valley'])
    })

    it('frees up the other units on a stay that dodges their closures', () => {
      expect(bookableStays('2026-10-05', '2026-10-07').map((stay) => stay.unitId)).toEqual([
        'garden-twin',
        'deluxe-valley',
        'treetop-suite',
        'valley-pool-villa',
      ])
    })

    it('orders the listing cheapest first', () => {
      const cheapest = cheapestBookable(REFERENCE_WINDOW.from, REFERENCE_WINDOW.to)
      expect(cheapest.map((stay) => `${stay.unitId}=${stay.totalMinor}`)).toEqual([
        'deluxe-valley=8742360',
      ])
    })
  })
})
