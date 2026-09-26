import type { CapabilityTierName, EnvironmentName, PresenceTierName } from '@archava/config'
import type { ConfiguratorIntake, IntegrationNeed, TransactionMode } from './intake.js'

/**
 * From onboarding answers to a recommended scope (PRD §14.1).
 *
 * This is the only place the configurator makes a recommendation, and it makes
 * it by rules that a person can read. Every tier choice here is a consequence
 * of something the client said, so the "why" is derivable rather than a matter
 * of taste — which is what makes the same intake produce the same scope twice.
 *
 * The rule that governs all of it: **the client's stated preference is honoured
 * unless what they asked the assistant to do requires more than it can do.**
 * Someone who chose `chat` but needs to run `payment.capture` needs `transact`,
 * and the recommendation says so instead of quietly pricing a tier that cannot
 * do the job.
 */

/** What the assistant must actually be able to do, read off the intake. */
export interface RecommendedScope {
  readonly presence: PresenceTierName
  readonly capability: CapabilityTierName
  readonly environment: EnvironmentName
  /** Counts by complexity, already reduced to what the launch requires. */
  readonly integrations: {
    readonly standard: number
    readonly custom: number
    readonly advanced: number
    readonly enterprise: number
  }
  /** Every place the recommendation differs from what the client asked for. */
  readonly overrides: readonly ScopeOverride[]
}

/** A disagreement between what the client picked and what the scope needs. */
export interface ScopeOverride {
  readonly field: 'presence' | 'capability' | 'environment'
  readonly asked: string
  readonly recommended: string
  readonly reason: string
}

/** Actions that can only run at `transact`, because money moves (§18). */
const TRANSACTIONAL_ACTION_PREFIXES = [
  'payment.',
  'checkout.',
  'order.cancel',
  'subscription.',
  'refund',
] as const

function needsTransact(intake: ConfiguratorIntake): boolean {
  if (intake.transactionMode === 'payments_only') return true
  if (intake.transactionMode === 'checkout_orders') return true
  if (intake.transactionMode === 'mixed') return true
  return intake.actionsRequired.some((id) => matchesAny(id, TRANSACTIONAL_ACTION_PREFIXES))
}

function needsAct(intake: ConfiguratorIntake): boolean {
  if (intake.actionsRequired.length > 0) return true
  return (
    intake.transactionMode === 'booking' ||
    intake.transactionMode === 'mixed' ||
    intake.transactionMode === 'checkout_orders'
  )
}

function matchesAny(actionId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => actionId.startsWith(prefix))
}

/**
 * The presence tier: the client's preference, unless a compliance obligation or
 * a transactional scope makes `chat` untenable. Preserving the preference is the
 * point — a raise is explained, never assumed.
 */
function recommendPresence(intake: ConfiguratorIntake): {
  presence: PresenceTierName
  override: ScopeOverride | null
} {
  const regulated = intake.compliance.some((need) => need !== 'none')
  if (intake.presence === 'chat' && needsTransact(intake) && regulated) {
    return {
      presence: 'voice',
      override: {
        field: 'presence',
        asked: 'chat',
        recommended: 'voice',
        reason:
          'A payment flow under a compliance obligation needs a confirmation step a text turn cannot carry.',
      },
    }
  }
  return { presence: intake.presence, override: null }
}

/**
 * The capability tier: the floor the requested actions set, never the ceiling.
 * `assist` when the client asked for nothing that acts.
 *
 * The environment arrives as an argument rather than being re-derived, because
 * the raised case below needs it: an enterprise-scale integration is only an
 * enterprise capability when the launch is actually landing on an enterprise
 * system, and the one place that is decided is `recommendEnvironment`. An ERP
 * integration behind a booking flow is an enterprise engagement; the same
 * integration on a brochure site is not, and pricing it as one would quote a
 * capability the client never asked to buy.
 */
function recommendCapability(
  intake: ConfiguratorIntake,
  environment: EnvironmentName,
): {
  capability: CapabilityTierName
  override: ScopeOverride | null
} {
  if (needsTransact(intake)) {
    const enterpriseIntegration = intake.integrations.some(
      (item) => item.complexity === 'enterprise',
    )
    if (environment === 'enterprise_system' && enterpriseIntegration) {
      return {
        capability: 'enterprise',
        override: {
          field: 'capability',
          asked: capabilityFloorLabel(intake),
          recommended: 'enterprise',
          reason:
            'An enterprise-system integration that takes payments is an enterprise capability.',
        },
      }
    }
    return { capability: 'transact', override: null }
  }
  if (needsAct(intake)) {
    return { capability: 'act', override: null }
  }
  return { capability: 'assist', override: null }
}

/**
 * A stable "asked" label for the capability override. The intake does not carry
 * a capability, so the label is the floor the actions themselves imply — which
 * is the honest thing to say the recommendation raised.
 */
function capabilityFloorLabel(intake: ConfiguratorIntake): string {
  if (needsTransact(intake)) return 'transact'
  if (needsAct(intake)) return 'act'
  return 'assist'
}

/** Environment tiers that require work beyond deploying onto them. */
const ENVIRONMENT_BY_TRANSACTION: readonly {
  readonly mode: TransactionMode
  readonly environment: EnvironmentName
}[] = [
  { mode: 'booking', environment: 'commerce_booking' },
  { mode: 'checkout_orders', environment: 'commerce_booking' },
  { mode: 'mixed', environment: 'commerce_booking' },
]

/**
 * The one step up the environment rank this scope needs, if any.
 *
 * Ordered strongest first, because the reasons do not stack: a required
 * enterprise-scale integration is already a reason not to price a fixed
 * environment, and adding "it also takes bookings" would describe the same jump
 * twice while moving the operator no further.
 */
interface EnvironmentRaise {
  readonly environment: EnvironmentName
  readonly reason: string
}

function environmentRaise(intake: ConfiguratorIntake): EnvironmentRaise | null {
  if (countIntegrations(intake.integrations).enterprise > 0) {
    return {
      environment: 'enterprise_system',
      reason:
        'A required enterprise-scale integration lands on an enterprise system, which the pricebook prices as custom scope only.',
    }
  }
  const transactional = ENVIRONMENT_BY_TRANSACTION.find(
    (entry) => entry.mode === intake.transactionMode,
  )
  if (!transactional) return null
  return {
    environment: transactional.environment,
    reason: `Taking ${intake.transactionMode.replace('_', ' ')} needs a commerce and booking environment.`,
  }
}

function recommendEnvironment(intake: ConfiguratorIntake): {
  environment: EnvironmentName
  override: ScopeOverride | null
} {
  const baseline = environmentForWebsite(intake)
  const raised = environmentRaise(intake)
  if (raised && rankEnvironment(baseline) < rankEnvironment(raised.environment)) {
    return {
      environment: raised.environment,
      override: {
        field: 'environment',
        asked: baseline,
        recommended: raised.environment,
        reason: raised.reason,
      },
    }
  }
  return { environment: baseline, override: null }
}

/** Whatever they already have is the cheapest starting point that fits. */
function environmentForWebsite(intake: ConfiguratorIntake): EnvironmentName {
  switch (intake.existingWebsite.status) {
    case 'live':
      return 'existing_site'
    case 'stale':
      return 'business'
    case 'under_construction':
      return 'business'
    case 'none':
      return industryDefaultEnvironment(intake.industry)
  }
}

function industryDefaultEnvironment(industry: string): EnvironmentName {
  switch (industry) {
    case 'ecommerce':
      return 'commerce_booking'
    case 'professional_services':
    case 'clinic':
      return 'business'
    default:
      return 'landing'
  }
}

/**
 * A total order over environments, so "does this transaction need more than
 * what they already have" is a comparison rather than a list of special cases.
 * Rank is cost of work, not quality.
 */
const ENVIRONMENT_RANK: readonly EnvironmentName[] = [
  'existing_site',
  'landing',
  'business',
  'commerce_booking',
  'custom_web_app',
  'enterprise_system',
]

function rankEnvironment(environment: EnvironmentName): number {
  return ENVIRONMENT_RANK.indexOf(environment)
}

/** Count only the integrations the launch actually requires. */
function countIntegrations(needs: readonly IntegrationNeed[]): RecommendedScope['integrations'] {
  const counts = { standard: 0, custom: 0, advanced: 0, enterprise: 0 }
  for (const need of needs) {
    if (need.required) counts[need.complexity] += 1
  }
  return counts
}

/** Derive the recommended scope from onboarding answers. Deterministic. */
export function recommendScope(intake: ConfiguratorIntake): RecommendedScope {
  const presence = recommendPresence(intake)
  const environment = recommendEnvironment(intake)
  const capability = recommendCapability(intake, environment.environment)
  return {
    presence: presence.presence,
    capability: capability.capability,
    environment: environment.environment,
    integrations: countIntegrations(intake.integrations),
    overrides: [presence.override, capability.override, environment.override].filter(
      (value): value is ScopeOverride => value !== null,
    ),
  }
}
