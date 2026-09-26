/**
 * The exponent that turns stored money into money a visitor reads.
 *
 * The platform stores a price as `amountMinor` paired with a `currency` (§25),
 * and that pairing means nothing on its own: `1_438_000` is a figure, not an
 * amount, until something says how many minor units the major unit contains. The
 * divisor is therefore part of this platform's *data contract* — a fact about the
 * number that was stored — and this module is where it is written down.
 *
 * It is written down rather than read out of `Intl`, because `Intl` is not a
 * source of facts about stored data. It is a description of how the reader's ICU
 * dataset prefers to print things, and that description differs by operating
 * system, by Node build (`full-icu` versus `small-icu`), by Node version, and by
 * whatever the browser shipped with. CI proved it: the same `formatToParts(1)`
 * returned two fraction digits for IDR on the runner and zero on the laptop that
 * wrote the code. One stored number meant two different prices, and the
 * disagreement was invisible to every gate that ran on one machine.
 *
 * So `Intl` keeps exactly one job — presenting a number that has already been
 * scaled, in a way that reads well in a locale. `Intl.NumberFormat(...).format`
 * is presentation. `Intl.NumberFormat(...).formatToParts()` is not, and this
 * module exists so that no caller can reach for it.
 *
 * Two properties the table is built to give:
 *
 * 1. **Exhaustive.** `satisfies Record<CurrencyCode, number>` fails to compile
 *    when a currency is added to the platform without also saying how it scales.
 *    A currency the platform accepts but cannot scale is a currency it must not
 *    quote, and the compiler is the cheapest place to say so.
 * 2. **Fail closed.** `minorUnitExponent` throws on an undeclared currency
 *    rather than returning a default. There is no safe default: 2 is the
 *    assumption that under-quoted the guest by a factor of a hundred, and an
 *    unrecognised code means the producer stored something this platform does
 *    not know the scale of — which is a defect in the producer, and rendering it
 *    anyway is how a visitor reads a price that is a hundredfold wrong and has no
 *    way to notice.
 */

/** The currencies the platform prices in. One list, no second definition. */
export const SUPPORTED_CURRENCIES = ['IDR', 'USD'] as const
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]

/**
 * Minor units per major unit, as the number of fractional digits.
 *
 * IDR is 0: the minor unit is the rupiah, which is why the reference tenant
 * stores `amountMinor: 1_438_000` for 1,438,000 whole rupiah. USD is 2: cents,
 * which is why `amountMinor: 14_380` is $143.80 and not $14,380.
 */
export const CURRENCY_MINOR_UNIT_EXPONENTS = {
  IDR: 0,
  USD: 2,
} as const satisfies Readonly<Record<CurrencyCode, number>>

/** Raised when money arrives in a currency this platform cannot scale. */
export class UnknownCurrencyError extends Error {
  constructor(currency: string) {
    super(
      `currency ${JSON.stringify(currency)} is not one the platform can scale; ` +
        `expected one of ${SUPPORTED_CURRENCIES.join(', ')}`,
    )
    this.name = 'UnknownCurrencyError'
  }
}

/** Whether `currency` is one the platform declares a scaling for. */
export function isSupportedCurrency(currency: string): currency is CurrencyCode {
  return Object.hasOwn(CURRENCY_MINOR_UNIT_EXPONENTS, currency)
}

/**
 * How many decimal places `currency` uses.
 *
 * Throws rather than guessing, for the reason the module header gives: a divisor
 * that is assumed is a price that is silently wrong. Callers that need to decline
 * an unsupported currency without an exception can check `isSupportedCurrency`
 * first, but the ones that draw a number on a screen should not, because every
 * caller is better off failing on an amount it cannot render honestly than
 * rendering one it cannot vouch for.
 */
export function minorUnitExponent(currency: string): number {
  if (!isSupportedCurrency(currency)) throw new UnknownCurrencyError(currency)
  return CURRENCY_MINOR_UNIT_EXPONENTS[currency]
}

/**
 * The divisor between minor units and the major unit a visitor reads.
 *
 * `10 ** 0` is 1, so a zero-decimal currency divides by nothing and the stored
 * figure is the figure on screen. That is deliberate rather than a special case:
 * one expression covers both, so there is no branch where a zero-decimal currency
 * could be scaled by accident.
 */
export function minorUnitDivisor(currency: string): number {
  return 10 ** minorUnitExponent(currency)
}
