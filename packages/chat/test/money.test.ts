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

/**
 * The fraction digits a rendered amount carries, counted as the locale counts.
 *
 * A digit total cannot say *where* the digits fall: `1,438,000` and
 * `1,438,000,00` are seven and nine digits, which the assertions below already
 * separate, but neither string names which comma is the decimal separator — and
 * the answer is a locale's to give (`id-ID` groups with `.` and separates with
 * `,`; `en-US` does the reverse). So the separator is read from the locale
 * first, from a number with grouping switched off so no grouping separator can
 * impersonate it, and then used to split the rendered string.
 *
 * What is counted is digits, not characters, for the same reason `digitsOf`
 * exists: `ar-EG` writes its decimals in Arabic-Indic, and a `.length` on the
 * tail would be counting the right glyphs by accident.
 */
function fractionDigitsOf(rendered: string, locale: string): number {
  const separator =
    new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
      .formatToParts(0.5)
      .find((part) => part.type === 'decimal')?.value ?? '.'
  const cut = rendered.lastIndexOf(separator)
  return cut === -1 ? 0 : (rendered.slice(cut + separator.length).match(/\p{Nd}/gu) ?? []).length
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

describe('formatMoney fraction digits', () => {
  it('renders no decimals for IDR and exactly two for USD, in every locale', () => {
    // The audit's requirement, said in the only place it can be said: per locale,
    // because a locale is the one input that used to be able to change the answer.
    // IDR's exponent is 0, so a rendered fraction is a fraction the platform never
    // declared; USD's is 2, so a rounded one is a price that lost its cents.
    for (const locale of LOCALES) {
      expect(fractionDigitsOf(formatMoney(1_438_000, IDR, locale), locale)).toBe(
        currencyFractionDigits(IDR),
      )
      expect(fractionDigitsOf(formatMoney(14_380, USD, locale), locale)).toBe(
        currencyFractionDigits(USD),
      )
    }
  })

  it('renders no decimals for IDR in a locale Intl has no data for', () => {
    // `xx-YY` is not a locale, so `Intl` answers it with whatever the host's
    // default is — which on the GitHub runner is a dataset that reports two
    // fraction digits for IDR. This is the assertion that failed in CI, run
    // against the variable that caused it, so it fails there and nowhere else.
    expect(fractionDigitsOf(formatMoney(1_438_000, IDR, 'xx-YY'), 'xx-YY')).toBe(0)
    expect(fractionDigitsOf(formatMoney(14_380, USD, 'xx-YY'), 'xx-YY')).toBe(2)
  })

  it('writes the two exact strings the CI failure reported', () => {
    // The runner printed `IDR 1,438,000.00` where the laptop printed
    // `IDR 1,438,000`, and `Rp 1.438.000,00` where it printed `Rp 1.438.000`.
    // Both wrong strings are named here rather than described, so a regression
    // that reintroduces either one fails on the string itself.
    expect(formatMoney(1_438_000, IDR, 'en')).toBe('IDR 1,438,000')
    expect(formatMoney(1_438_000, IDR, 'en')).not.toBe('IDR 1,438,000.00')
    expect(formatMoney(1_438_000, IDR, 'id')).toBe('Rp 1.438.000')
    expect(formatMoney(1_438_000, IDR, 'id')).not.toBe('Rp 1.438.000,00')
  })

  it('decides the digit count from the exponent, not from Intl’s own opinion', () => {
    // The half of the rule that is easy to get right by accident: pin the digits
    // for IDR and USD specifically and a table of two entries would pass. So ask
    // `Intl` what it would have chosen, and assert the rendered count is the
    // contract's number whether the two agree or not — which is the only form of
    // this test that still means something on a host whose ICU dataset says IDR
    // has a minor unit. Skipped where the host has no data for the currency, since
    // that is `Intl` declining to answer rather than answering differently.
    for (const [amountMinor, currency, locale] of [
      [1_438_000, IDR, 'en-US'],
      [1_438_000, IDR, 'id-ID'],
      [14_380, USD, 'en-US'],
      [14_380, USD, 'de-DE'],
    ] as const) {
      const intlWouldChoose = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits
      const rendered = formatMoney(amountMinor, currency, locale)
      expect(fractionDigitsOf(rendered, locale)).toBe(currencyFractionDigits(currency))
      if (intlWouldChoose !== currencyFractionDigits(currency)) {
        expect(fractionDigitsOf(rendered, locale)).not.toBe(intlWouldChoose)
      }
    }
  })

  it('renders zero decimals for IDR even on a host that would give it two', () => {
    // The assertion above can only fail on a host that already disagrees, and the
    // two hosts in this bug's history were one that agrees and one that does not
    // — so it would have stayed green on the laptop that wrote it. This one fails
    // everywhere: it hands `Intl` a dataset that answers "two fraction digits for
    // IDR", which is the answer the GitHub runner's gave, and requires the
    // rendered number to come back with none anyway. Remove the pins from
    // `formatMoney` and this is the test that goes red on any machine.
    const realNumberFormat = Intl.NumberFormat
    /** The real formatter, reached through the same global the module reaches. */
    class HostileIDRNumberFormat extends realNumberFormat {
      constructor(...args: ConstructorParameters<typeof realNumberFormat>) {
        const [locales, options] = args
        // Only the formatter `formatMoney` builds is redirected — the one with the
        // pins in it — and only when the caller left them out, which is the state
        // this whole bug lived in. Anything else (`fractionDigitsOf`, the
        // `resolvedOptions` probe above) goes to the real dataset untouched.
        const hostile = options?.currency === IDR && options?.minimumFractionDigits === undefined
        super(
          locales,
          hostile ? { ...options, minimumFractionDigits: 2, maximumFractionDigits: 2 } : options,
        )
      }
    }
    try {
      // `Intl.NumberFormat` is typed as callable as well as newable, and a class
      // is only the second of those — so installing a subclass in its place
      // needs a cast. It gives up nothing this test relies on: `formatMoney`
      // reaches the global through `new` and nothing else, and a stand-in that
      // could not be *called* is a stand-in nothing here can reach by accident.
      Intl.NumberFormat = HostileIDRNumberFormat as unknown as typeof Intl.NumberFormat
      // Pinned, so the stand-in dataset is consulted and then overridden.
      expect(formatMoney(1_438_000, IDR, 'id')).toBe('Rp 1.438.000')
      expect(formatMoney(1_438_000, IDR, 'en')).toBe('IDR 1,438,000')
      expect(fractionDigitsOf(formatMoney(1_438_000, IDR, 'en'), 'en')).toBe(0)
      // USD's exponent is 2, so the pins and the hostile dataset happen to agree
      // and the amount survives unchanged — the fix narrows the variable, it does
      // not flatten every currency to the same number of digits.
      expect(formatMoney(14_380, USD, 'en')).toBe('$143.80')
      expect(fractionDigitsOf(formatMoney(14_380, USD, 'en'), 'en')).toBe(2)
    } finally {
      Intl.NumberFormat = realNumberFormat
    }
  })

  it('leaves the formatter alone once the stand-in is put back', () => {
    // A stub that leaks past its `finally` would make every later assertion in this
    // file a test of the stub. Restating the plain case here is what keeps that
    // honest, and it is cheap.
    expect(formatMoney(1_438_000, IDR, 'id')).toBe('Rp 1.438.000')
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
