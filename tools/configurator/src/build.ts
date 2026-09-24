import type { PricingEngine, Quote, QuoteRequest } from '@archava/pricing'
import { assessBudget, type BudgetAssessment } from './budget.js'
import type { ConfiguratorIntake } from './intake.js'
import { normalizeScope, type NormalizedScope } from './normalized.js'
import { quoteRequestFor } from './quote.js'
import { recommendScope, type RecommendedScope } from './recommend.js'
import { buildVariants, type VariantRequest, type VariantName } from './variants.js'

/**
 * One intake, three priced variants, one selection (§14.1, §19).
 *
 * The configurator's whole job, in one function: answers in, comparable numbers
 * out. Every variant is priced by the same `PricingEngine`, so the three are
 * directly comparable and none of them can quietly move a tier to make its
 * number look better.
 *
 * The engine is injected rather than constructed because `loadPricebook()`
 * reads the working directory. A caller that cannot control its cwd — a studio
 * route serving many tenants, a test — passes an engine built from a pricebook
 * it already holds, and gets the same result twice.
 */

export type { VariantName } from './variants.js'

export interface PricedVariant {
  readonly variant: VariantName
  /** The pricebook request, kept so a quote can be reproduced from a config set. */
  readonly request: QuoteRequest
  readonly quote: Quote
  readonly scope: NormalizedScope
  /** `null` when the client stated no budget — not a verdict of zero. */
  readonly budget: BudgetAssessment | null
}

export interface ConfigSet {
  readonly intake: ConfiguratorIntake
  readonly scope: RecommendedScope
  /** Recommended, budget, premium — the order §14.1 lists them in. */
  readonly variants: readonly PricedVariant[]
  readonly selected: VariantName
  readonly selectionReason: string
}

/**
 * Build and price the three variants, then pick the one an operator reads.
 *
 * Selection is a rule, not a preference, and it is written down so a different
 * answer is a debate about the rule rather than a surprise:
 *
 * 1. No stated budget → **recommended**. There is nothing to compare against,
 *    so the scope the client asked for is the honest answer.
 * 2. Budget stated and the recommendation fits → **recommended**. Never trade
 *    down a client who can afford what they asked for; a budget is a ceiling,
 *    not a target.
 * 3. Budget stated and the recommendation does not fit → the first variant in
 *    §14.1 order that fits, which is the budget variant unless the premium is
 *    the only thing that fits.
 * 4. Nothing fits → **recommended**, with a reason that says by how much it
 *    misses. Silently substituting a smaller scope would answer a question the
 *    client did not ask; the over-budget number is the finding.
 *
 * `needs_scoping` counts as fitting, because the floor is a real lower bound and
 * the final price is still open. It is flagged in the reason rather than
 * reported as settled.
 */
export function buildConfigSet(intake: ConfiguratorIntake, engine: PricingEngine): ConfigSet {
  const scope = recommendScope(intake)
  const variants = buildVariants(intake, scope).map((variant) =>
    priceVariant(intake, variant, engine),
  )
  const selected = selectVariant(variants)
  return { intake, scope, variants, selected: selected.variant, selectionReason: selected.reason }
}

function priceVariant(
  intake: ConfiguratorIntake,
  variant: VariantRequest,
  engine: PricingEngine,
): PricedVariant {
  const request = quoteRequestFor(intake, variant)
  const quote = engine.quoteRequest(request)
  return {
    variant: variant.variant,
    request,
    quote,
    scope: normalizeScope(intake, variant),
    budget: assessBudget(intake.budget, quote),
  }
}

/** The chosen variant and the reason it was chosen, decided together so they cannot disagree. */
function selectVariant(variants: readonly PricedVariant[]): {
  variant: VariantName
  reason: string
} {
  const byName = new Map(variants.map((entry) => [entry.variant, entry]))
  const recommended = byName.get('recommended')
  if (!recommended) throw new Error('the configurator built no recommended variant')

  if (!variants.some((entry) => entry.budget !== null)) {
    return {
      variant: 'recommended',
      reason:
        'The client stated no budget, so the recommended scope is the answer — there is nothing to trade it down against.',
    }
  }

  const fits = (entry: PricedVariant): boolean =>
    entry.budget?.verdict === 'within_budget' || entry.budget?.verdict === 'needs_scoping'

  if (fits(recommended)) return { variant: 'recommended', reason: recommendedReason(recommended) }

  const fallback = variants.find((entry) => fits(entry))
  if (!fallback) {
    return {
      variant: 'recommended',
      reason: `No variant fits the stated budget of ${statedBudget(recommended)} — the recommendation misses it by ${shortfall(recommended)}, and trading down would answer a different question than the one asked.`,
    }
  }

  return {
    variant: fallback.variant,
    reason: `The recommendation is over budget by ${shortfall(recommended)}, so ${fallback.variant} is the first variant in §14.1 order that fits.`,
  }
}

function recommendedReason(entry: PricedVariant): string {
  if (entry.budget?.verdict === 'needs_scoping') {
    return `The recommendation fits the stated budget of ${statedBudget(entry)} on the minimum build, with the final price still open.`
  }
  return `The recommendation fits inside the stated budget of ${statedBudget(entry)}.`
}

/** Budget as the client said it, so a reason never quotes a number unattributed. */
function statedBudget(entry: PricedVariant): string {
  const budget = entry.budget?.budget
  if (!budget) return 'the stated budget'
  return `${budget.amount} ${budget.currency}`
}

function shortfall(entry: PricedVariant): string {
  const margin = entry.budget?.margin
  if (margin === null || margin === undefined) return 'an unstated amount'
  return `${Math.abs(margin)} ${entry.budget?.budget.currency ?? ''}`.trim()
}
