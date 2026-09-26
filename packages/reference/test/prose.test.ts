import { describe, expect, it } from 'vitest'
import { formatMoney, referenceTruth, renderStructuredTruth } from '../src/index.js'

/**
 * The reference tenant's prose renderer.
 *
 * This is the defect-A coverage: the browser E2E showed a chat bubble holding a
 * stringified price snapshot, because `ScriptedBrain` is deliberately
 * schema-agnostic and can only `JSON.stringify` what the port resolved. The
 * renderer here is the tenant saying the same record back in words, so what is
 * under test is the claim the module header makes — that it selects from the
 * record and never invents, and that it says how partial the answer is.
 *
 * Two styles are used deliberately. Hand-built records pin the *format*: a change
 * to `./rates.js` should not turn a passing suite red for reasons that have
 * nothing to do with the renderer. The real snapshots from `referenceTruth` cover
 * the *mapping* — that a visitor's phrasing reaches a figure the record actually
 * holds — which is the part a fixture could get wrong by construction.
 */

/**
 * A price snapshot over one unit for one night, the smallest useful shape.
 *
 * Wrapped in its subject, because that is the shape the port hands over: a record
 * maps subject names to the values it resolved, and a bare price object would be
 * eight keys the renderer has no renderer for.
 */
function priceRecord(
  nights: readonly { unitId: string; night: string; amountMinor: number }[],
  window = { from: '2026-10-05', to: '2026-10-06' },
): Readonly<Record<string, unknown>> {
  return { price: { currency: 'IDR', window, nights } }
}

/** One night's rate for one unit, as the price snapshot carries it. */
function night(unitId: string, amountMinor: number) {
  return { unitId, night: '2026-10-05', amountMinor }
}

describe('formatMoney', () => {
  it('treats IDR as zero-decimal, because its minor unit is the rupiah itself', () => {
    expect(formatMoney(2_415_000, 'IDR')).toBe('IDR 2,415,000')
  })

  it('divides a two-decimal currency rather than guessing at it', () => {
    expect(formatMoney(24_150_0, 'USD')).toBe('USD 2,415')
    expect(formatMoney(24_155_0, 'USD')).toBe('USD 2,416')
  })

  it('groups digits so a price does not read as a latitude', () => {
    expect(formatMoney(850_000, 'IDR')).toBe('IDR 850,000')
    expect(formatMoney(0, 'IDR')).toBe('IDR 0')
  })

  it('keeps a negative amount negative, with the sign on the figure', () => {
    // A refund or a credit reaches this as a negative minor amount, and the
    // currency code is not the thing being negated.
    expect(formatMoney(-5_000, 'IDR')).toBe('IDR -5,000')
  })
})

describe('renderStructuredTruth', () => {
  it('reads the unit out of the question and answers only that unit', () => {
    // The claim the module exists for. A visitor says "treetop suite" where the
    // record says `treetop-suite`, and the match has to survive the hyphen.
    expect(
      renderStructuredTruth(priceRecord([night('treetop-suite', 2_100_000)]), 'the treetop suite?'),
    ).toBe('5 October to 6 October: treetop-suite is IDR 2,100,000 per night.')
  })

  it('does not narrow on a fragment of an id', () => {
    // "a valley" is half of `valley-pool-villa`. Answering as though the visitor
    // had named the villa would be answering a question they did not ask, so the
    // whole snapshot is reported instead — and neither unit is singled out.
    const record = priceRecord([
      night('treetop-suite', 2_100_000),
      night('valley-pool-villa', 3_400_000),
    ])
    const rendered = renderStructuredTruth(record, 'is there a valley?')
    expect(rendered).not.toContain('valley-pool-villa is')
    expect(rendered).toContain('rates run')
  })

  it('reports a span, not one figure lifted out of several nights', () => {
    // Several nights are in the snapshot and the question named one unit, so the
    // honest answer is the range over that unit's nights. Picking either end
    // would answer a night the visitor did not ask about.
    const several = priceRecord([
      night('treetop-suite', 2_100_000),
      { unitId: 'treetop-suite', night: '2026-10-10', amountMinor: 2_415_000 },
    ])
    expect(renderStructuredTruth(several, 'the treetop-suite please')).toBe(
      '5 October to 6 October: treetop-suite is IDR 2,100,000 to IDR 2,415,000 per night.',
    )
  })

  it('counts rooms out of the stock snapshot', () => {
    const stock = {
      stock: {
        units: [
          { unitId: 'garden-twin', name: 'Garden Twin Room', roomsBuilt: 4 },
          { unitId: 'treetop-suite', name: 'Treetop Suite', roomsBuilt: 2 },
        ],
      },
    }
    expect(renderStructuredTruth(stock, 'how many rooms do you have?')).toBe(
      'We have 4 × Garden Twin Room and 2 × Treetop Suite.',
    )
  })

  it('skips a unit whose count it cannot read, rather than printing undefined', () => {
    const stock = { stock: { units: [{ unitId: 'treetop-suite', name: 'Treetop Suite' }] } }
    expect(renderStructuredTruth(stock, 'how many?')).toBe('I have no live count for that.')
  })

  it('quotes the window and says plainly when nothing is bookable', () => {
    const availability = {
      availability: { window: { from: '2026-10-05', to: '2026-10-11' }, bookable: [] },
    }
    // "Nothing is bookable" is a real answer, and it is the one the record
    // supports — an empty list is not a reason to say nothing at all.
    expect(renderStructuredTruth(availability, 'what can I book?')).toBe(
      '5 October to 11 October: nothing is bookable.',
    )
  })

  it('names a subject it cannot put into words instead of dropping it', () => {
    // The platform resolves eight subjects and this fixture renders three.
    // Silence about the other five would be a gap the turn report never shows.
    const record = {
      ...priceRecord([night('treetop-suite', 2_100_000)]),
      booking_status: { reference: 'BK-1' },
    }
    expect(renderStructuredTruth(record, 'where is my booking?')).toBe(
      '5 October to 6 October: rates run IDR 2,100,000 per night (treetop-suite IDR 2,100,000). (I cannot put booking_status into words.)',
    )
  })

  it('returns null rather than inventing words when nothing renders', () => {
    // The caller keeps the inner reply on null, so this must not fire for a
    // record that merely failed to inspire a sentence.
    expect(renderStructuredTruth({}, 'anything')).toBeNull()
    expect(
      renderStructuredTruth({ booking_status: { reference: 'BK-1' } }, 'where is it?'),
    ).toBeNull()
    expect(renderStructuredTruth({ price: 'not a record' }, 'anything')).toBeNull()
  })
})

describe('the renderer against the records the port actually resolves', () => {
  /**
   * The real snapshots, awaited because `referenceTruth` is a
   * `StructuredTruthPort` and the port's contract is a promise. Reading the
   * record without awaiting would be the bug the contract exists to prevent.
   */
  async function resolved(
    ...subjects: Parameters<typeof referenceTruth.resolve>[0]
  ): Promise<Readonly<Record<string, unknown>>> {
    return referenceTruth.resolve(subjects)
  }

  it('narrows a real price snapshot to the unit the visitor named', async () => {
    const record = await resolved('price')
    const rendered = renderStructuredTruth(record, 'how much is the treetop suite?')
    expect(rendered).toContain('treetop-suite is IDR 2,100,000 to IDR 2,415,000 per night.')
    // …and says nothing about the units that were not asked about.
    expect(rendered).not.toContain('valley-pool-villa')
  })

  it('reports the whole snapshot as a span plus each unit, when nothing is named', async () => {
    const record = await resolved('price')
    const rendered = renderStructuredTruth(record, 'what are the rates?')
    expect(rendered).toContain('5 October to 11 October: rates run IDR 850,000 to IDR 3,910,000')
    for (const unit of ['garden-twin', 'deluxe-valley', 'treetop-suite', 'valley-pool-villa']) {
      expect(rendered).toContain(unit)
    }
  })

  it('counts the rooms the tenant actually built', async () => {
    const record = await resolved('stock')
    const rendered = renderStructuredTruth(record, 'how many rooms do you have?')
    expect(rendered).toContain('× Treetop Suite')
    expect(rendered).not.toContain('undefined')
  })

  it('prices a stay the tenant can actually book', async () => {
    const record = await resolved('availability')
    const rendered = renderStructuredTruth(record, 'what can I book?')
    expect(rendered).toContain('5 October to 11 October: we can book')
    expect(rendered).toContain('at IDR ')
    expect(rendered).not.toContain('undefined')
  })
})
