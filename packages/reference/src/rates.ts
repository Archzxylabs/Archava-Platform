/**
 * The reference tenant's rates and availability: fixtures, answered through the
 * port a live PMS would answer through.
 *
 * PRD §17 draws a line the assistant may not cross on its own judgement:
 * "Do not answer these from stale vector retrieval when a live system exists."
 * Price, stock and availability are on the live side of that line. So this file
 * does not put a rate in a sentence for the model to retrieve — it implements
 * `StructuredTruthPort`, the same interface a PMS adapter would implement, and
 * every price the demo ever says came out of `resolve()`.
 *
 * Three things this file is careful about:
 *
 * - The window is fixed (`REFERENCE_NIGHTS`, derived from `REFERENCE_WINDOW`).
 *   "Is the Treetop free on the 7th?" has to get the same answer in October as
 *   it does in March, which rules out anything that reads a calendar.
 * - The dates have stated weekday facts behind them. 2026-10-05 is a Monday, so
 *   the 9th and 10th are the weekend nights, and only those two carry the
 *   uplift. A rate table that varies for no stated reason teaches the demo to
 *   look arbitrary.
 * - `booking_status`, `customer_or_order` and `payment_status` are deliberately
 *   *not* answered (see `UNANSWERED_SUBJECTS`). A port can only see subject
 *   names, never the utterance, so answering "my booking" from a shared fixture
 *   would hand every visitor the demo's reference codes. Leaving them out makes
 *   `resolveTruth` record a knowledge gap, which is the honest answer and the
 *   §17 behaviour an operator wants to see demonstrated.
 */

import type { StructuredTruthPort } from '@archava/assistant'
import type { StructuredTruthSubject } from '@archava/knowledge'
import { REFERENCE_CURRENCY, REFERENCE_WINDOW, referenceUnits } from './tenant.js'

/** Money in the platform's shape: minor units plus the currency it is in. */
export interface Money {
  readonly amountMinor: number
  readonly currency: string
}

/** One unit's rate for one night. `amountMinor` is IDR, whose minor unit is 1. */
export interface NightlyRate {
  readonly unitId: string
  /** ISO date of the night being sold (the check-in date it covers). */
  readonly night: string
  readonly amountMinor: number
  readonly currency: string
}

/** One unit's availability for one night. */
export interface NightlyAvailability {
  readonly unitId: string
  readonly night: string
  readonly available: boolean
  /** Rooms of this type still sellable that night. `0` means closed. */
  readonly unitsLeft: number
}

/** Availability across a whole stay, which is what a booking actually needs. */
export interface StayAvailability {
  readonly unitId: string
  readonly from: string
  readonly to: string
  readonly nights: readonly NightlyAvailability[]
  /** True only when *every* night of the stay is sellable. */
  readonly everyNightAvailable: boolean
}

/** The money for a stay, including the tax line the fixtures state. */
export interface StayQuote {
  readonly unitId: string
  readonly from: string
  readonly to: string
  readonly nights: readonly NightlyRate[]
  readonly subtotalMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
  readonly currency: string
}

/**
 * The nights the fixtures cover, as a closed list.
 *
 * A stay runs from its check-in night up to — but not including — its
 * check-out date, so the six nights are the 5th through the 10th and
 * `REFERENCE_WINDOW.to` ('2026-10-11') is the checkout, not a night.
 */
export const REFERENCE_NIGHTS = [
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
  '2026-10-10',
] as const

export type ReferenceNight = (typeof REFERENCE_NIGHTS)[number]

/**
 * The dates a stay may end on: every night the fixtures sell, plus the checkout
 * that follows the last of them.
 *
 * `to` is exclusive — a guest occupies nights, and leaves on the morning of the
 * checkout date — so the window's end is a legal bound that is not itself a
 * night. Without it the canonical six-night stay ended on a date this list did
 * not contain and priced nothing at all, which would have made every listing
 * page in the demo an empty list.
 */
const REFERENCE_BOUNDS = [...REFERENCE_NIGHTS, REFERENCE_WINDOW.to] as const

type ReferenceBound = (typeof REFERENCE_BOUNDS)[number]

/**
 * The base nightly rate per unit, before the weekend uplift.
 *
 * Keyed by the unit id the config declares, so a unit that stops existing stops
 * having a rate rather than quietly keeping a stale one.
 */
const BASE_RATES: Readonly<Record<string, number>> = {
  'garden-twin': 850_000,
  'deluxe-valley': 1_250_000,
  'treetop-suite': 2_100_000,
  'valley-pool-villa': 3_400_000,
}

/** How many rooms of each type the resort actually has. */
const ROOMS_BUILT: Readonly<Record<string, number>> = {
  'garden-twin': 4,
  'deluxe-valley': 6,
  'treetop-suite': 2,
  'valley-pool-villa': 2,
}

/**
 * Nights a unit type is closed outright.
 *
 * Stated as facts an operator would recognise — a wedding party holding the
 * garden wing, a villa closed for the arrival it follows — because a fixture
 * that closes rooms for no reason is a fixture nobody can demo from.
 */
const CLOSED_NIGHTS: Readonly<Record<string, readonly string[]>> = {
  'garden-twin': ['2026-10-08', '2026-10-09'],
  'treetop-suite': ['2026-10-07'],
  'valley-pool-villa': ['2026-10-10'],
}

/**
 * Nights where a group booking has taken most of a type, leaving a remainder.
 *
 * The interesting case for the demo: the room is still sellable, but the page
 * should not imply there are plenty.
 */
const REMAINING_OVERRIDES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'deluxe-valley': { '2026-10-09': 2 },
}

/** The Friday and Saturday of the window (2026-10-05 is a Monday). */
const WEEKEND_NIGHTS: readonly string[] = ['2026-10-09', '2026-10-10']

/** The weekend uplift, stated so the demo can explain it rather than assert it. */
export const WEEKEND_UPLIFT_PERCENT = 15

/** Rates are quoted to the nearest thousand, as the resort's price list does. */
const RATE_STEP = 1_000

/** The tax the fixtures apply. A real tenant's line comes from its own tax system. */
export const REFERENCE_TAX = {
  code: 'PPN',
  label: 'PPN 11%',
  ratePercent: 11,
} as const

/**
 * Subjects this tenant answers from a live system.
 *
 * Anything outside this list is a knowledge gap by design. The pipeline asks
 * for what the *question* needs; a port that is asked about something it does
 * not own says nothing, and `runTurn` reports `basis: 'none'` rather than
 * letting retrieval stand in for the PMS.
 */
export const TRUTH_SUBJECTS_ANSWERED: readonly StructuredTruthSubject[] = [
  'price',
  'stock',
  'availability',
]

/**
 * Subjects a shared demo port must not answer, with the reason.
 *
 * A port sees subject names only — never the utterance — so there is no way to
 * scope "my booking" to the visitor asking. Answering anyway would leak the
 * demo's own records to whoever asks first.
 */
export const UNANSWERED_SUBJECTS: readonly StructuredTruthSubject[] = [
  'booking_status',
  'customer_or_order',
  'payment_status',
  'shipping_status',
  'account_state',
]

/** True for a night the fixtures cover. */
export function isReferenceNight(night: string): night is ReferenceNight {
  return (REFERENCE_NIGHTS as readonly string[]).includes(night)
}

/** Rooms of this unit type the resort has. `undefined` for a unit it does not own. */
export function roomsBuilt(unitId: string): number | undefined {
  return ROOMS_BUILT[unitId]
}

/** The base nightly rate, before any uplift. `undefined` for an unknown unit. */
export function baseRate(unitId: string): number | undefined {
  return BASE_RATES[unitId]
}

/** True when the night carries the weekend uplift. */
export function isWeekendNight(night: string): boolean {
  return WEEKEND_NIGHTS.includes(night)
}

function roundToStep(amount: number, step: number): number {
  return Math.round(amount / step) * step
}

/**
 * The weekend rate for a base rate.
 *
 * The uplift is added rather than multiplied in, on purpose. `base * 1.15` is
 * not exact in binary floating point — 850,000 x 1.15 is 977499.9999999999,
 * which prints as 977,500 but rounds *down* — so rounding the product quoted
 * the garden twin at 977,000 for a 977,500 tie while the deluxe's identical tie
 * rounded up. One stated rule, two answers, decided by nothing the operator
 * ever said. Both factors are integers here, so the tie lands the same way for
 * every unit.
 */
function weekendRate(base: number): number {
  const uplift = Math.round((base * WEEKEND_UPLIFT_PERCENT) / 100)
  return roundToStep(base + uplift, RATE_STEP)
}

/** The rate for one unit on one night, uplift included. */
export function nightlyRate(unitId: string, night: string): NightlyRate | undefined {
  const base = BASE_RATES[unitId]
  if (base === undefined || !isReferenceNight(night)) return undefined
  return {
    unitId,
    night,
    amountMinor: isWeekendNight(night) ? weekendRate(base) : base,
    currency: REFERENCE_CURRENCY,
  }
}

/** Availability for one unit on one night. */
export function nightlyAvailability(unitId: string, night: string): NightlyAvailability | undefined {
  const built = ROOMS_BUILT[unitId]
  if (built === undefined || !isReferenceNight(night)) return undefined
  const closed = (CLOSED_NIGHTS[unitId] ?? []).includes(night)
  const unitsLeft = closed ? 0 : (REMAINING_OVERRIDES[unitId]?.[night] ?? built)
  return { unitId, night, available: unitsLeft > 0, unitsLeft }
}

/**
 * The nights a stay covers, as dates: check-in night through the night before
 * checkout.
 *
 * Returns an empty list for a window the fixtures do not state, rather than
 * extrapolating. A demo that prices a stay it has no rate for is worse than one
 * that says it cannot.
 */
export function nightsBetween(from: string, to: string): readonly string[] {
  const start = REFERENCE_NIGHTS.indexOf(from as ReferenceNight)
  const end = REFERENCE_BOUNDS.indexOf(to as ReferenceBound)
  if (start < 0 || end < 0 || end <= start) return []
  return REFERENCE_NIGHTS.slice(start, end)
}

/** Availability for a whole stay. `undefined` when either end is outside the fixtures. */
export function stayAvailability(
  unitId: string,
  from: string,
  to: string,
): StayAvailability | undefined {
  const nights = nightsBetween(from, to)
  if (nights.length === 0) return undefined
  const read = nights.flatMap((night) => {
    const each = nightlyAvailability(unitId, night)
    return each === undefined ? [] : [each]
  })
  if (read.length !== nights.length) return undefined
  return {
    unitId,
    from,
    to,
    nights: read,
    everyNightAvailable: read.every((night) => night.available),
  }
}

/**
 * The money for a stay: nightly rates, the stated tax line, and the total.
 *
 * Returns `undefined` for a unit or window the fixtures do not cover. Note it
 * returns a quote even for a stay that cannot be sold — the price of an
 * unavailable stay is a real question — so callers who care about sellability
 * ask `stayAvailability` too.
 */
export function stayQuote(unitId: string, from: string, to: string): StayQuote | undefined {
  const nights = nightsBetween(from, to)
  if (nights.length === 0) return undefined
  const rates = nights.flatMap((night) => {
    const rate = nightlyRate(unitId, night)
    return rate === undefined ? [] : [rate]
  })
  if (rates.length !== nights.length) return undefined
  const subtotalMinor = rates.reduce((sum, rate) => sum + rate.amountMinor, 0)
  const taxMinor = Math.round((subtotalMinor * REFERENCE_TAX.ratePercent) / 100)
  return {
    unitId,
    from,
    to,
    nights: rates,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    currency: REFERENCE_CURRENCY,
  }
}

/**
 * Every unit that can actually be booked across a stay, with its quote.
 *
 * This is what a recommendation list should be built from: a card for a closed
 * room is not a recommendation, it is a way to disappoint someone twice.
 */
export function bookableStays(
  from: string,
  to: string,
): readonly (StayQuote & { readonly availability: StayAvailability })[] {
  return referenceUnits.flatMap((unit) => {
    const quote = stayQuote(unit.id, from, to)
    const availability = stayAvailability(unit.id, from, to)
    if (quote === undefined || availability === undefined) return []
    if (!availability.everyNightAvailable) return []
    return [{ ...quote, availability }]
  })
}

/** The units a listing page would show as sellable, cheapest first. */
export function cheapestBookable(
  from: string,
  to: string,
): readonly (StayQuote & { readonly availability: StayAvailability })[] {
  return [...bookableStays(from, to)].sort((left, right) => left.totalMinor - right.totalMinor)
}

/** What the port answers for `price`. */
function priceSnapshot(): Readonly<Record<string, unknown>> {
  return {
    currency: REFERENCE_CURRENCY,
    window: REFERENCE_WINDOW,
    nights: referenceUnits.flatMap((unit) =>
      REFERENCE_NIGHTS.flatMap((night) => {
        const rate = nightlyRate(unit.id, night)
        return rate === undefined ? [] : [rate]
      }),
    ),
    weekendUpliftPercent: WEEKEND_UPLIFT_PERCENT,
    tax: REFERENCE_TAX,
  }
}

/** What the port answers for `stock`: how many rooms of each type exist. */
function stockSnapshot(): Readonly<Record<string, unknown>> {
  return {
    units: referenceUnits.map((unit) => ({
      unitId: unit.id,
      name: unit.name,
      roomsBuilt: ROOMS_BUILT[unit.id] ?? 0,
    })),
  }
}

/** What the port answers for `availability`: every sellable unit across the window. */
function availabilitySnapshot(): Readonly<Record<string, unknown>> {
  return {
    window: REFERENCE_WINDOW,
    bookable: bookableStays(REFERENCE_WINDOW.from, REFERENCE_WINDOW.to).map((stay) => ({
      unitId: stay.unitId,
      from: stay.from,
      to: stay.to,
      nights: stay.nights.length,
      totalMinor: stay.totalMinor,
      currency: stay.currency,
    })),
  }
}

const SNAPSHOTS: Readonly<Record<string, () => Readonly<Record<string, unknown>>>> = {
  price: priceSnapshot,
  stock: stockSnapshot,
  availability: availabilitySnapshot,
}

/**
 * The reference tenant's live-system port.
 *
 * The record keys are the subject names the pipeline asked about, so
 * `runTurn`'s `resolveTruth` sees a non-empty record exactly when this port
 * genuinely answered. A subject it does not own is absent from the record, not
 * answered with a shrug: absence is what makes `basis: 'none'` and the §27
 * knowledge gap fire.
 */
export const referenceTruth: StructuredTruthPort = {
  resolve: (subjects: readonly StructuredTruthSubject[]): Readonly<Record<string, unknown>> => {
    const answered: Record<string, unknown> = {}
    for (const subject of subjects) {
      const snapshot = SNAPSHOTS[subject]
      if (snapshot === undefined) continue
      answered[subject] = snapshot()
    }
    return answered
  },
}
