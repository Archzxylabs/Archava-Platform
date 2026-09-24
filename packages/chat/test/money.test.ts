import { describe, expect, it } from 'vitest'
import { MoneyFormatError, currencyFractionDigits, formatMoney } from '../src/index.js'

/**
 * Money, formatted from the currency rather than from an assumption.
 *
 * The reference tenant prices in IDR (`packages/reference/src/rates.ts`), whose
 * minor unit is 1 — so the same `amountMinor` means whole rupiah there and cents
 * in USD. A formatter that hard-coded `/100` would under-quote an Indonesian
 * guest by a factor of a hundred, which is the one error in this package with a
 * number attached to it, so both directions are pinned here.
 */

const IDR = 'IDR'
const USD = 'USD'

describe('currencyFractionDigits', () => {
  it('reads two decimal places from USD', () => {
    expect(currencyFractionDigits(USD, 'en')).toBe(2)
  })

  it('reads zero from a currency whose minor unit is itself', () => {
    expect(currencyFractionDigits(IDR, 'id')).toBe(0)
    expect(currencyFractionDigits('JPY', 'en')).toBe(0)
  })
})

describe('formatMoney', () => {
  it('divides by the currency’s own divisor, not by a hundred', () => {
    expect(formatMoney(1_438_000, IDR, 'id')).toBe('Rp 1.438.000')
    expect(formatMoney(14_380, USD, 'en')).toBe('$143.80')
  })

  it('spells the currency the tenant trades in, whatever the browser says', () => {
    // The locale is the tenant's language: `Rp` for an Indonesian visitor, the
    // ISO code for one reading English. Both are 1,438,000.
    expect(formatMoney(1_438_000, IDR, 'id')).toContain('Rp')
    expect(formatMoney(1_438_000, IDR, 'en')).toContain('1,438,000')
  })

  it('leaves a zero-decimal total whole', () => {
    expect(formatMoney(500, 'JPY', 'en')).toBe('¥500')
  })

  it('refuses a total that is not a number at all', () => {
    // A decided turn carrying a non-numeric total is a producer defect. Rendering
    // a dash would hide it behind a plausible-looking empty cell.
    expect(() => formatMoney(Number.NaN, USD, 'en')).toThrow(MoneyFormatError)
    expect(() => formatMoney(Number.POSITIVE_INFINITY, USD, 'en')).toThrow(MoneyFormatError)
  })
})
