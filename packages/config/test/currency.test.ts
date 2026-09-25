import { describe, expect, it } from 'vitest'
import {
  CURRENCY_MINOR_UNIT_EXPONENTS,
  SUPPORTED_CURRENCIES,
  UnknownCurrencyError,
  isSupportedCurrency,
  minorUnitDivisor,
  minorUnitExponent,
} from '../src/currency.js'

/**
 * The platform's currency contract, asserted as a contract.
 *
 * The point of this file is not that IDR divides by one. It is that scaling is a
 * fact *declared here* and nowhere else, so no two renderers can hold two
 * answers — which is precisely what the CI failure looked like: the chat shell
 * and the reference renderer each had their own rule, and the runner's ICU data
 * silently made the first one wrong.
 *
 * An ICU dataset cannot appear in this file at all. Nothing here reads `Intl`,
 * and if a future change reintroduced `Intl.NumberFormat` into any scaling
 * decision these assertions would not catch it — `money.test.ts` in
 * `@archava/chat` does, by varying the locale. This file pins the table; that
 * one pins its independence from the machine reading it.
 */

describe('supported currencies', () => {
  it('is the exact set the pricebook schema accepts', () => {
    // `regionSchema` builds `z.enum(SUPPORTED_CURRENCIES)`, so this list *is*
    // the set of currencies a region may quote in. A currency here that the
    // pricebook cannot write is a currency nobody can price in.
    expect([...SUPPORTED_CURRENCIES]).toEqual(['IDR', 'USD'])
  })

  it('declares an exponent for every currency it lists', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(CURRENCY_MINOR_UNIT_EXPONENTS).toHaveProperty(currency)
      expect(Number.isInteger(minorUnitExponent(currency))).toBe(true)
      expect(minorUnitExponent(currency)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('minorUnitExponent', () => {
  it('scales IDR by 1, so a stored rupiah figure is the figure on screen', () => {
    expect(minorUnitExponent('IDR')).toBe(0)
    expect(minorUnitDivisor('IDR')).toBe(1)
  })

  it('scales USD by a hundred, so 14_380 minor units is $143.80', () => {
    expect(minorUnitExponent('USD')).toBe(2)
    expect(minorUnitDivisor('USD')).toBe(100)
  })
})

describe('isSupportedCurrency', () => {
  it('accepts a declared currency', () => {
    expect(isSupportedCurrency('IDR')).toBe(true)
    expect(isSupportedCurrency('USD')).toBe(true)
  })

  it('rejects an undeclared one without throwing', () => {
    // The check exists so a caller can decline an unsupported currency
    // deliberately; a throw would make it useless for that purpose.
    expect(isSupportedCurrency('JPY')).toBe(false)
    expect(isSupportedCurrency('')).toBe(false)
    expect(isSupportedCurrency('usd')).toBe(false)
  })

  it('does not inherit Object.prototype keys', () => {
    // `Object.hasOwn`, not `in`: a currency called "constructor" is not a
    // currency, and reading one out of the prototype chain would hand a
    // divisor to a code nobody declared.
    expect(isSupportedCurrency('constructor')).toBe(false)
    expect(isSupportedCurrency('toString')).toBe(false)
  })
})

describe('minorUnitExponent on an undeclared currency', () => {
  it('throws rather than defaulting', () => {
    expect(() => minorUnitExponent('JPY')).toThrow(UnknownCurrencyError)
    expect(() => minorUnitExponent('EUR')).toThrow(UnknownCurrencyError)
  })

  it('names the currency it refused', () => {
    // The message has to say *which* currency was refused, or a producer
    // debugging a scaling failure has nothing to grep for.
    expect(() => minorUnitExponent('JPY')).toThrow(/JPY/)
    expect(() => minorUnitExponent('JPY')).toThrow(/IDR, USD/)
  })

  it('throws an error whose name survives after it is caught', () => {
    let caught: unknown
    try {
      minorUnitExponent('GBP')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('UnknownCurrencyError')
  })
})
