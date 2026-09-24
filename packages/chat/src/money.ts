/**
 * Money, formatted for a visitor without restating what a live system said.
 *
 * A shell that draws an `order_summary` holds exactly one amount, paired by
 * schema with the currency it is in (§25's `amountMinor` + `currency` pair
 * exists so a number can never appear bare). That pairing is the whole problem:
 * "1250000" is meaningless, "Rp 1.438.000" is not — but which of those it is
 * depends on the currency's *minor unit*, not on the field name.
 *
 * IDR is the interesting case. Its minor unit is 1, so the reference tenant's
 * `amountMinor: 1_438_000` (`packages/reference/src/rates.ts`) is 1,438,000
 * whole rupiah, and a formatter that assumed two decimal places would print
 * `IDR 14,380` — off by a factor of a hundred, in the direction that
 * under-quotes a guest. So the divisor is read from the currency through
 * `Intl`, never assumed. A currency whose ICU digits disagree with the
 * producer's convention is then a data bug that shows up in exactly one place
 * instead of a silent factor-of-100 error.
 */

/** Raised when an amount reaches the formatter that cannot be money at all. */
export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyFormatError'
  }
}

/**
 * How many decimal places `currency` uses, as ICU defines it.
 *
 * Read rather than hard-coded: USD → 2, IDR and JPY → 0. This is the divisor
 * between `amountMinor` and the major unit a visitor reads.
 */
export function currencyFractionDigits(currency: string, locale: string): number {
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).formatToParts(1)
  const fraction = parts.find((part) => part.type === 'fraction')
  return fraction?.value.length ?? 0
}

/**
 * Minor units as the string a visitor reads: `Rp 1.438.000`, `$14,380.00`.
 *
 * `locale` is the tenant's language, not the browser's — a resort in Yogyakarta
 * should show `Rp` to an Indonesian visitor regardless of where the browser is
 * set. An amount that is not a finite number throws rather than rendering as a
 * dash: a decided turn that carries a non-numeric total is a defect in the
 * producer, and a dash in the total would hide it behind a plausible-looking
 * empty cell.
 */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isFinite(amountMinor)) {
    throw new MoneyFormatError(`amount must be a finite number, received ${String(amountMinor)}`)
  }
  const digits = currencyFractionDigits(currency, locale)
  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(amountMinor / 10 ** digits)
  // ICU joins a currency symbol to its amount with a non-breaking space, which
  // keeps the pair together when a visitor widens the column — but it also means
  // the string a shell renders, and the string a caller compares against, are
  // different characters. Normalised to a plain space, the separator no longer
  // leaks into tests or into a page's own text content.
  return formatted.replace(/[\u00a0\u202f]/g, ' ')
}
