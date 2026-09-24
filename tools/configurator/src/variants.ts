import type { DesignAddonName } from '@archava/config'
import type { ConfiguratorIntake } from './intake.js'
import type { RecommendedScope, ScopeOverride } from './recommend.js'

/**
 * The three variants (PRD §14.1: "recommended, budget, or premium").
 *
 * A variant is a scope, not a price — the price comes from the same pricebook
 * the recommended scope uses, so the three are directly comparable and none of
 * them can quietly move a tier to make its number look better.
 *
 * The budget variant is the one that carries the weight. §19 says it must be a
 * *valid* configuration, so it removes work (design addons, optional support,
 * integrations explicitly marked not required, premium presence) and never
 * capability. A budget quote that cannot book is not a cheaper building, it is a
 * different product wearing the same name.
 */

/** Which variant a quote belongs to. */
export type VariantName = 'recommended' | 'budget' | 'premium'

/** A scope plus the intake details a quote still needs. */
export interface VariantRequest {
  readonly variant: VariantName
  readonly presence: RecommendedScope['presence']
  readonly capability: RecommendedScope['capability']
  readonly environment: RecommendedScope['environment']
  readonly designAddons: readonly DesignAddonName[]
  readonly support: ConfiguratorIntake['support']
  readonly annualPrepay: boolean
  readonly usageForecast: number | undefined
  readonly integrations: RecommendedScope['integrations']
  /** Integrations that were required by the intake but dropped by this variant. */
  readonly omittedIntegrations: readonly { readonly name: string; readonly reason: string }[]
  /**
   * The scope's overrides, carried forward unchanged. A variant cannot change
   * what the scope raised, so it repeats the record rather than starting a new
   * one — every variant that ships keeps the reason it differs from what the
   * client asked for.
   */
  readonly overrides: readonly ScopeOverride[]
}

/**
 * The recommended variant: the scope as derived, with everything the intake
 * asked for. This is the one an operator reads first.
 */
export function recommendedVariant(
  intake: ConfiguratorIntake,
  scope: RecommendedScope,
): VariantRequest {
  return {
    variant: 'recommended',
    presence: scope.presence,
    capability: scope.capability,
    environment: scope.environment,
    designAddons: [...intake.customDesign],
    support: intake.support,
    annualPrepay: intake.annualPrepay,
    usageForecast:
      intake.expectedConversationsPerMonth > 0 ? intake.expectedConversationsPerMonth : undefined,
    integrations: scope.integrations,
    omittedIntegrations: [],
    overrides: [...scope.overrides],
  }
}

/**
 * The budget variant: `recommended` minus the work that is genuinely optional.
 *
 * Capability and environment are never dropped — the client still asked for the
 * thing. What comes off is design addons, anything above standard support, and
 * integrations the intake itself marked not required.
 */
export function budgetVariant(intake: ConfiguratorIntake, scope: RecommendedScope): VariantRequest {
  const omitted = intake.integrations
    .filter((item) => !item.required)
    .map((item) => ({ name: item.name, reason: 'marked not required for launch' }))

  return {
    variant: 'budget',
    presence: scope.presence,
    capability: scope.capability,
    environment: scope.environment,
    designAddons: [],
    support: 'standard',
    annualPrepay: false,
    usageForecast: undefined,
    integrations: scope.integrations,
    omittedIntegrations: omitted,
    overrides: [...scope.overrides],
  }
}

/**
 * What the premium variant adds over the recommended scope, in design terms.
 *
 * The client may already have asked for it — a premium offer that repeats what
 * someone already bought is not an offer, and the engine would price the same
 * addon twice.
 */
const PREMIUM_DESIGN: DesignAddonName = 'custom_visual_direction'

/**
 * The premium variant: the recommended scope plus the presence the client may
 * not have asked for. Offered only — §14.1 says "optionally Premium", and a
 * premium nobody can use is a number that only serves the sales deck.
 */
export function premiumVariant(
  intake: ConfiguratorIntake,
  scope: RecommendedScope,
): VariantRequest {
  return {
    variant: 'premium',
    presence: nextPresence(scope.presence),
    capability: scope.capability,
    environment: scope.environment,
    designAddons: withPremiumDesign(intake.customDesign),
    support: intake.support === 'standard' ? 'priority' : intake.support,
    annualPrepay: intake.annualPrepay,
    usageForecast:
      intake.expectedConversationsPerMonth > 0 ? intake.expectedConversationsPerMonth : undefined,
    integrations: scope.integrations,
    omittedIntegrations: [],
    overrides: [...scope.overrides],
  }
}

/**
 * Adds the premium direction unless the client already named it. The engine
 * prices each entry it is handed, so a repeat is a second charge for work that
 * happens once.
 */
function withPremiumDesign(requested: readonly DesignAddonName[]): readonly DesignAddonName[] {
  return requested.includes(PREMIUM_DESIGN) ? [...requested] : [...requested, PREMIUM_DESIGN]
}

/** One presence tier up. `human` is the ceiling. */
function nextPresence(presence: RecommendedScope['presence']): RecommendedScope['presence'] {
  switch (presence) {
    case 'chat':
      return 'voice'
    case 'voice':
      return 'human'
    case 'human':
      return 'human'
  }
}

/** All three variants, in the order §14.1 lists them. */
export function buildVariants(
  intake: ConfiguratorIntake,
  scope: RecommendedScope,
): readonly VariantRequest[] {
  return [
    recommendedVariant(intake, scope),
    budgetVariant(intake, scope),
    premiumVariant(intake, scope),
  ]
}
