import { describe, expect, it } from 'vitest'
import {
  MoneyFormatError,
  currencyFractionDigits,
  formatMoney,
  minorUnitExponent,
} from '../src/index.js'
import { UnknownCurrencyError } from '@archava/config'

/**
 * Money, scaled by the platform's contract and presented by `Intl`.
 *
 * The reference tenant prices in IDR (`packages/reference/src/rates.ts`), whose
 * minor unit is 1 — so the same `amountMinor` means whole rupiah there and cents
 * in USD. A formatter that hard-coded `/100` would under-quote an Indonesian
 * guest by a factor of a hundred, which is the one error in this package with a
 * number attached to it, so both directions are pinned here.
 *
 * The divisor used to be read from
 * `new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(1)`,
 * and that made a *stored* price depend on the ICU dataset of the machine
 * printing it. CI proved it: IDR gained two fraction digits on the GitHub runner
 * and lost them on the laptop that wrote the code, so `amountMinor: 1_438_000`
 * meant Rp 1.438.000 in one place and Rp 14.380,00 in the other. Same input, two
 * prices, and no gate that ran on a single machine could see it.
 *
 * So this file asserts the thing that broke, in the only form that would have
 * caught it: for a fixed `amountMinor`, the digits on screen are identical in
 * every locale `Intl` will accept, including one it does not know. The rest of
 * the assertions are about presentation, which *should* vary — `Rp` versus the
 * ISO code, comma versus dot — and is therefore never used to decide a number.
 */

const IDR = 'IDR'
const USD = 'USD'

/** Locales whose numerals ICU renders as the 0-9 this file is written in. */
const LATIN_LOCALES = ['id-ID', 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP']

/** Every locale the assertions below run the number through. */
const LOCALES = [...LATIN_LOCALES, 'ar-EG', 'xx-YY']

/**
 * The digit characters a rendered string carries.
 *
 * `\d` is a shorthand for 0-9, and some locales do not render 0-9: `ar-EG`
 * writes `١٬٤٣٨٬٠٠٠`, and stripping those characters as "not digits" would make
 * the assertion below silently vacuous in exactly the locale that varies most.
 * `\p{Nd}` is the Unicode property covering every decimal digit, so a digit is
 * a digit whichever script the tenant's numerals arrive in.
 */
function digitsOf(rendered: string): readonly string[] {
  return rendered.match(/\p{Nd}/gu) ?? []
}

describe('currencyFractionDigits', () => {
  it('reads two decimal places from USD', () => {
    expect(currencyFractionDigits(USD)).toBe(2)
  })

  it('reads zero from a currency whose minor unit is itself', () => {
    expect(currencyFractionDigits(IDR)).toBe(0)
  })

  it('is the same number the platform contract declares', () => {
    // One definition. If these two ever disagree, a shell that asked the chat
    // formatter and a producer that asked the platform contract are rendering
    // the same stored amount at two different scales.
    expect(currencyFractionDigits(IDR)).toBe(minorUnitExponent(IDR))
    expect(currencyFractionDigits(USD)).toBe(minorUnitExponent(USD))
  })
})

describe('formatMoney scaling', () => {
  it('divides by the currency’s own divisor, not by a hundred', () => {
    expect(formatMoney(1_438_000, IDR, 'id')).toBe('Rp 1.438.000')
    expect(formatMoney(14_380, USD, 'en')).toBe('$143.80')
  })

  it('puts the same number of digits on screen in every locale Intl accepts', () => {
    // The regression the CI failure deserves. The locale is the tenant's
    // language, and changing it changes symbols, grouping and which script the
    // numerals arrive in — it must not change how many digits the number has.
    // A count is what a locale can be held to: seven digits for 1,438,000, and
    // nine the moment a runner decides IDR has a minor unit.
    for (const locale of LOCALES) {
      expect(digitsOf(formatMoney(1_438_000, IDR, locale)).length).toBe(7)
      expect(digitsOf(formatMoney(14_380, USD, locale)).length).toBe(5)
    }
  })

  it('spells the same value in every locale that renders Latin digits', () => {
    // A count cannot catch a digit changed in place. These locales are the ones
    // whose numerals ICU writes as 0-9, so the value is pinned as well as the
    // length; `ar-EG` is pinned by the count alone, because a value written in
    // Arabic-Indic digits is not a string this file can compare against.
    for (const locale of LATIN_LOCALES) {
      expect(digitsOf(formatMoney(1_438_000, IDR, locale)).join('')).toBe('1438000')
      expect(digitsOf(formatMoney(14_380, USD, locale)).join('')).toBe('14380')
    }
  })

  it('puts the same number of digits on screen in a locale Intl has no data for', () => {
    // `xx-YY` is not a real locale. `Intl` falls back to its default, which is
    // whatever ICU the host happens to ship — the same variability that broke
    // CI, aimed straight at the digit count. It gets the number anyway, and the
    // count is the claim that survives the host having any default at all.
    expect(digitsOf(formatMoney(1_438_000, IDR, 'xx-YY')).length).toBe(7)
    expect(digitsOf(formatMoney(14_380, USD, 'xx-YY')).length).toBe(5)
  })

  it('never lets a locale give IDR a fraction', () => {
    // The failure mode named in the audit: a runner whose ICU data reports two
    // fraction digits for IDR. A fraction is the only thing that would make the
    // digit count nine rather than seven, so the count above already refuses it
    // in every locale; this pins the shape too, because "IDR 1,438,000.00" is
    // what the under-quoting actually looked like.
    for (const locale of LATIN_LOCALES) {
      expect(formatMoney(1_438_000, IDR, locale)).not.toMatch(/[,.]0{2}$/)
    }
  })

  it('keeps a small USD amount at two decimals instead of rounding it away', () => {
    // A divisor of 1 — what IDR's rule gives if someone "simplifies" the table
    // — turns 1438 minor units into 1,438 dollars. Both directions of the
    // hundred are now pinned.
    expect(formatMoney(1_438, USD, 'en')).toBe('$14.38')
  })
})

describe('formatMoney presentation', () => {
  it('spells the currency the tenant trades in, whatever the browser says', () => {
    // The locale is the tenant's language: `Rp` for an Indonesian visitor, the
    // ISO code for one reading English. Both are 1,438,000.
    expect(formatMoney(1_438_000, IDR, 'id')).toContain('Rp')
    expect(formatMoney(1_438_000, IDR, 'en')).toContain('1,438,000')
  })

  it('separates the symbol from the number with an ordinary space', () => {
    // ICU joins them with a non-breaking space, which is invisible in the page
    // and in every assertion that reads its text. A plain space is what a
    // visitor's screen reader announces and what a test compares against.
    expect(formatMoney(1_438_000, IDR, 'id')).toContain('Rp 1.438.000')
  })
})

describe('formatMoney failure', () => {
  it('refuses a total that is not a number at all', () => {
    // A decided turn carrying a non-numeric total is a producer defect. Rendering
    // a dash would hide it behind a plausible-looking empty cell.
    expect(() => formatMoney(Number.NaN, USD, 'en')).toThrow(MoneyFormatError)
    expect(() => formatMoney(Number.POSITIVE_INFINITY, USD, 'en')).toThrow(MoneyFormatError)
  })

  it('refuses a currency the platform has no exponent for', () => {
    // Fail closed. Scaling a currency nobody declared is the defect the module
    // exists to prevent: the alternative to a throw is a guessed divisor, and a
    // guessed divisor is a price that is silently wrong.
    expect(() => formatMoney(1_438_000, 'JPY', 'ja-JP')).toThrow(UnknownCurrencyError)
    expect(() => formatMoney(1_438_000, 'IDR ', 'id')).toThrow(UnknownCurrencyError)
  })
})
