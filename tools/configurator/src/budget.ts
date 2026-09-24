import type { Quote } from '@archava/pricing'
import type { BudgetNeed } from './intake.js'

/**
 * PRD §19: does what the client asked for fit what they said they can spend?
 *
 * The verdict is deliberately narrow. It answers one question — *is the one-time
 * build inside the budget the client stated* — and it refuses to answer when it
 * cannot. A configurator that turns an unpriceable scope into a confident
 * "within budget" is telling an operator something no pricebook ever said, so
 * the unanswerable case has its own verdict rather than a default.
 *
 * Three rules govern every branch here:
 *
 * 1. **No stated budget means no verdict.** An absent budget is not a budget of
 *    zero and must never be treated as one; the intake keeps it optional for
 *    that reason, and this function returns `null` for it.
 * 2. **Numbers are only compared in the same currency.** A budget in USD
 *    against a quote in IDR is not a comparison, so it is reported as
 *    uncomparable rather than silently converted.
 * 3. **When there is no final price, the floor still answers "does it fit".**
 *    A quote marked `requiresCustomQuote` has a `fromMinimumTotal` — a real
 *    lower bound. If even that exceeds the budget, the answer is *no*, and no
 *    amount of scoping will change it.
 */

export type BudgetVerdict = 'within_budget' | 'exceeds_budget' | 'needs_scoping' | 'uncomparable'

/** Which figure the verdict was reached against. */
export type BudgetBasis = 'one_time_total' | 'minimum_total' | 'none'

export interface BudgetAssessment {
  readonly verdict: BudgetVerdict
  /** The budget as the client stated it, echoed so a verdict is never bare. */
  readonly budget: { readonly amount: number; readonly currency: 'USD' | 'IDR' }
  readonly basis: BudgetBasis
  /** The figure the verdict compared, or `null` when there was nothing to compare. */
  readonly compared: number | null
  /** `budget.amount - compared`. Negative means over. */
  readonly margin: number | null
  /** How much of the budget is left, to one decimal. Presentation math, not money. */
  readonly headroomPct: number | null
  /** Why the verdict is what it is, in a sentence an operator can read out. */
  readonly reason: string
}

export function assessBudget(
  budget: BudgetNeed | undefined,
  quote: Quote,
): BudgetAssessment | null {
  if (!budget) return null
  if (budget.currency !== quote.currency) {
    return {
      verdict: 'uncomparable',
      budget: { amount: budget.amount, currency: budget.currency },
      basis: 'none',
      compared: null,
      margin: null,
      headroomPct: null,
      reason: `The budget is in ${budget.currency} but this quote is priced in ${quote.currency}, so the two cannot be compared as stated.`,
    }
  }

  if (quote.oneTimeTotal !== null) {
    return verdictAgainst(
      budget,
      'one_time_total',
      quote.oneTimeTotal,
      quote.oneTimeTotal <= budget.amount
        ? 'The one-time build total fits inside the stated budget.'
        : 'The one-time build total exceeds the stated budget.',
    )
  }

  // No final price. The floor is still a real number, so test it.
  if (quote.fromMinimumTotal > budget.amount) {
    return verdictAgainst(
      budget,
      'minimum_total',
      quote.fromMinimumTotal,
      'Even the lowest possible build for this scope exceeds the stated budget; no amount of scoping brings it inside.',
    )
  }

  return {
    verdict: 'needs_scoping',
    budget: { amount: budget.amount, currency: budget.currency },
    basis: 'minimum_total',
    compared: quote.fromMinimumTotal,
    margin: budget.amount - quote.fromMinimumTotal,
    headroomPct: headroom(budget.amount, budget.amount - quote.fromMinimumTotal),
    reason:
      quote.unresolvedScopeDrivers.length > 0
        ? `This scope has no final price yet (${quote.unresolvedScopeDrivers.join('; ')}), so only the minimum build of ${quote.fromMinimumTotal} can be compared — it fits, with room still to be priced.`
        : 'This scope has no final price yet, so only the minimum build can be compared — it fits, with room still to be priced.',
  }
}

function verdictAgainst(
  budget: BudgetNeed,
  basis: BudgetBasis,
  compared: number,
  reason: string,
): BudgetAssessment {
  const margin = budget.amount - compared
  return {
    verdict: margin >= 0 ? 'within_budget' : 'exceeds_budget',
    budget: { amount: budget.amount, currency: budget.currency },
    basis,
    compared,
    margin,
    headroomPct: headroom(budget.amount, margin),
    reason,
  }
}

/** Share of the budget still unspent. One decimal, so a rendered number is stable. */
function headroom(budget: number, margin: number): number {
  if (budget === 0) return 0
  return Math.round((margin / budget) * 1000) / 10
}
