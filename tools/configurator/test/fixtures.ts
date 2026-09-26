import type { Quote } from '@archava/pricing'
import type { BudgetNeed, ConfiguratorIntake, IntegrationNeed } from '../src/index.js'

/**
 * Builders for the configurator tests.
 *
 * Both builders return a *complete* value, so a test that overrides one field is
 * varying exactly one thing. That is the whole point: these suites assert that a
 * single answer changes a single outcome, and a fixture that carried an unrelated
 * default (a budget nobody asked for, an integration nobody priced) would make a
 * passing test worthless for that purpose.
 *
 * Neither builder validates. Intake parsing is the module under test in
 * `intake.test.ts`, so a fixture that ran its own schema would hide the very
 * failures those tests look for — these values are typed, not parsed.
 */

/** A valid intake whose every optional answer is at its floor. */
export const BASE_INTAKE: ConfiguratorIntake = {
  clientId: 'acme-clinic',
  clientName: 'Acme Clinic',
  industry: 'clinic',
  region: 'ID',
  existingWebsite: { url: 'https://acme.example', status: 'stale' },
  businessGoals: ['Book appointments without phone tag'],
  presence: 'chat',
  actionsRequired: [],
  transactionMode: 'none',
  expectedConversationsPerMonth: 0,
  languages: [{ code: 'en', label: 'English' }],
  primaryLanguage: 'en',
  integrations: [],
  brandAssets: { logo: true, styleGuide: false, photography: false },
  compliance: ['none'],
  customDesign: [],
  support: 'standard',
  annualPrepay: false,
  targetLaunchDate: '2026-11-02',
}

export function makeIntake(overrides: Partial<ConfiguratorIntake> = {}): ConfiguratorIntake {
  return { ...BASE_INTAKE, ...overrides }
}

export function makeIntegration(
  overrides: Partial<IntegrationNeed> & { name: string },
): IntegrationNeed {
  return { complexity: 'standard', required: true, ...overrides }
}

export function makeBudget(overrides: Partial<BudgetNeed> = {}): BudgetNeed {
  return { amount: 1000, currency: 'USD', ...overrides }
}

const BASE_QUOTE: Quote = {
  region: 'ID',
  currency: 'IDR',
  presence: 'chat',
  capability: 'assist',
  environment: 'business',
  support: 'standard',
  coreComponents: [],
  paidCoreComponentCount: 0,
  bundleDiscountPct: 0,
  fixedCoreSetup: 0,
  discountedCoreSetup: 0,
  integrations: [],
  integrationSetupTotal: 0,
  designAddons: [],
  designAddonSetupTotal: 0,
  usageAllowance: null,
  overage: null,
  estimatedOverage: 0,
  oneTimeTotal: 800,
  monthlyBase: 0,
  annualPlatformOption: null,
  deterministicSubtotal: 800,
  fromMinimumTotal: 800,
  requiresCustomQuote: false,
  unresolvedScopeDrivers: [],
  roundedWithIncrement: 800,
}

/**
 * A quote varying only the fields a budget verdict reads. `oneTimeTotal` is null
 * in the custom-quote case, which is the state a real engine produces when a
 * `setup_from` line is still open.
 */
export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return { ...BASE_QUOTE, ...overrides }
}

/**
 * A quote the pricebook cannot finish: no final total, only a floor.
 *
 * The driver strings are the engine's own wording (see `PricingEngine`'s
 * `unresolvedScopeDrivers`), because a fixture that invented its own ids would
 * test a state the engine never produces.
 */
export function makeUnresolvedQuote(
  drivers: readonly string[] = ['1 enterprise integration(s) require manual scoping'],
): Quote {
  return makeQuote({
    oneTimeTotal: null,
    requiresCustomQuote: true,
    unresolvedScopeDrivers: drivers,
    fromMinimumTotal: 1200,
  })
}
