import type { QuoteRequest } from '@archava/pricing'
import type { ConfiguratorIntake } from './intake.js'
import type { VariantRequest } from './variants.js'

/**
 * A variant, translated into the pricebook's own request shape.
 *
 * The configurator never does arithmetic of its own on a price. It builds a
 * `QuoteRequest` and hands it to `PricingEngine`, which is the only thing in the
 * repo that knows how a line becomes a total. Keeping it that way is what makes
 * every number the configurator prints traceable to the same rounding, the same
 * bundle discount, and the same allowance rules the scenario tests assert — a
 * configurator that computed its own totals would drift from the pricebook the
 * first time the pricebook changed.
 *
 * This is a plain projection: every field here already exists upstream, so a
 * quote is reproducible from an intake by anyone reading the two of them. No
 * defaulting, no fallbacks — a missing usage forecast stays absent rather than
 * becoming an invented zero, because "not stated" and "stated as none" price
 * differently.
 */
export function quoteRequestFor(intake: ConfiguratorIntake, variant: VariantRequest): QuoteRequest {
  return {
    region: intake.region,
    presence: variant.presence,
    capability: variant.capability,
    environment: variant.environment,
    standardIntegrations: variant.integrations.standard,
    customIntegrations: variant.integrations.custom,
    advancedIntegrations: variant.integrations.advanced,
    enterpriseIntegrations: variant.integrations.enterprise,
    designAddons: variant.designAddons,
    support: variant.support,
    usageForecast: variant.usageForecast,
    annualPrepay: variant.annualPrepay,
  }
}
