import { describe, expect, it } from 'vitest'
import { assessBudget } from '../src/index.js'
import { makeBudget, makeQuote, makeUnresolvedQuote } from './fixtures.js'

/**
 * PRD §19 in three rules, each of which is a case here. The rule that most
 * needs a test is the first: an absent budget produces no verdict, and a
 * configurator that quietly returned "within budget" for a client who never
 * stated one would be inventing a constraint the client never gave it.
 *
 * Budgets here are expressed in IDR to match the base quote's currency; the two
 * cases that need USD say so on the quote too, because a mismatched currency is
 * refused rather than converted.
 */
describe('assessBudget', () => {
  it('returns no verdict when the client stated no budget', () => {
    expect(assessBudget(undefined, makeQuote())).toBeNull()
  })

  it('says the build fits and shows the headroom left', () => {
    const result = assessBudget(
      makeBudget({ amount: 1000, currency: 'IDR' }),
      makeQuote({ oneTimeTotal: 800 }),
    )
    expect(result?.verdict).toBe('within_budget')
    expect(result?.basis).toBe('one_time_total')
    expect(result?.compared).toBe(800)
    expect(result?.margin).toBe(200)
    expect(result?.headroomPct).toBe(20)
  })

  it('says the build exceeds the budget', () => {
    const result = assessBudget(
      makeBudget({ amount: 500, currency: 'IDR' }),
      makeQuote({ oneTimeTotal: 800 }),
    )
    expect(result?.verdict).toBe('exceeds_budget')
    expect(result?.margin).toBe(-300)
  })

  it('treats a budget equal to the total as fitting', () => {
    const result = assessBudget(
      makeBudget({ amount: 800, currency: 'IDR' }),
      makeQuote({ oneTimeTotal: 800 }),
    )
    expect(result?.verdict).toBe('within_budget')
    expect(result?.margin).toBe(0)
  })

  it('refuses to compare a USD budget against an IDR quote', () => {
    const result = assessBudget(
      makeBudget({ amount: 1000, currency: 'USD' }),
      makeQuote({ currency: 'IDR' }),
    )
    expect(result?.verdict).toBe('uncomparable')
    expect(result?.basis).toBe('none')
    expect(result?.compared).toBeNull()
    expect(result?.reason).toContain('USD')
    expect(result?.reason).toContain('IDR')
  })

  it('compares a USD budget against a USD quote', () => {
    const result = assessBudget(
      makeBudget({ amount: 1000, currency: 'USD' }),
      makeQuote({ currency: 'USD', oneTimeTotal: 900 }),
    )
    expect(result?.verdict).toBe('within_budget')
  })

  describe('when the pricebook cannot produce a final total', () => {
    it('answers no when even the floor is over the budget', () => {
      const result = assessBudget(
        makeBudget({ amount: 500, currency: 'IDR' }),
        makeUnresolvedQuote(),
      )
      expect(result?.verdict).toBe('exceeds_budget')
      expect(result?.basis).toBe('minimum_total')
      expect(result?.reason).toContain('no amount of scoping')
    })

    it('says the scope needs work when the floor fits but the price is open', () => {
      const result = assessBudget(
        makeBudget({ amount: 2000, currency: 'IDR' }),
        makeUnresolvedQuote(),
      )
      expect(result?.verdict).toBe('needs_scoping')
      expect(result?.basis).toBe('minimum_total')
      expect(result?.compared).toBe(1200)
      expect(result?.margin).toBe(800)
    })
  })

  it('echoes the budget as the client stated it, so a verdict is never bare', () => {
    const result = assessBudget(
      makeBudget({ amount: 45000000, currency: 'IDR' }),
      makeQuote({ currency: 'IDR' }),
    )
    expect(result?.budget).toEqual({ amount: 45000000, currency: 'IDR' })
  })

  it('never mutates the quote or the budget it was handed', () => {
    const budget = makeBudget({ amount: 1000, currency: 'IDR' })
    const quote = makeQuote({ oneTimeTotal: 800 })
    const budgetBefore = structuredClone(budget)
    const quoteBefore = structuredClone(quote)
    assessBudget(budget, quote)
    expect(budget).toEqual(budgetBefore)
    expect(quote).toEqual(quoteBefore)
  })
})
