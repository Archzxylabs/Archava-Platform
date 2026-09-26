import { classifyLine, loadPricebook, type Pricebook, type RegionCode } from '@archava/config'
import { roundCurrency } from './rounding.js'
import type { QuoteRequest, QuoteRequestInit } from './request.js'

export interface CoreComponent {
  readonly name: 'presence' | 'environment' | 'capability'
  readonly setup: number
  readonly countsTowardBundle: boolean
}

export interface IntegrationLine {
  readonly complexity: 'standard' | 'custom' | 'advanced' | 'enterprise'
  readonly count: number
  readonly unitSetup: number | null
  readonly total: number | null
  readonly fromMinimum: boolean
}

export interface Quote {
  readonly region: RegionCode
  readonly currency: 'USD' | 'IDR'
  readonly presence: string
  readonly capability: string
  readonly environment: string
  readonly support: string

  readonly coreComponents: readonly CoreComponent[]
  readonly paidCoreComponentCount: number
  readonly bundleDiscountPct: number
  readonly fixedCoreSetup: number
  readonly discountedCoreSetup: number

  readonly integrations: readonly IntegrationLine[]
  readonly integrationSetupTotal: number

  readonly designAddons: readonly {
    readonly name: string
    readonly setup: number
    readonly from: boolean
    readonly custom: boolean
  }[]
  readonly designAddonSetupTotal: number

  readonly usageAllowance: { readonly unit: string; readonly quantity: number } | null
  readonly overage: { readonly unit: string; readonly price: number } | null
  readonly estimatedOverage: number

  readonly oneTimeTotal: number | null
  readonly monthlyBase: number
  readonly annualPlatformOption: number | null

  /** Exact subtotal of every line that has a fixed price. */
  readonly deterministicSubtotal: number
  /** Lower bound once `setup_from` minimums are included; never a final price. */
  readonly fromMinimumTotal: number
  readonly requiresCustomQuote: boolean
  readonly unresolvedScopeDrivers: readonly string[]
  readonly roundedWithIncrement: number
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PricingError'
  }
}

function requireRegion(pricebook: Pricebook, region: RegionCode) {
  const selected = pricebook.regions[region]
  if (!selected) throw new PricingError(`Unknown region "${region}". No quote produced.`)
  return selected
}

function bundleDiscountPct(pricebook: Pricebook, paidCoreComponentCount: number): number {
  if (paidCoreComponentCount <= 1) return 0
  if (paidCoreComponentCount === 2)
    return pricebook.discount_rules.two_core_components_setup_discount_pct
  return pricebook.discount_rules.three_core_components_setup_discount_pct
}

/**
 * Deterministic quote engine.
 *
 * Implements PRD.md §11 and agent.md §12 exactly. Money comes only from
 * `config/pricing.v1.json`; this class contains no price constants at all.
 */
export class PricingEngine {
  private readonly pricebook: Pricebook

  constructor(pricebook?: Pricebook) {
    this.pricebook = pricebook ?? loadPricebook()
  }

  get schemaVersion(): string {
    return this.pricebook.schema_version
  }

  get effectiveDate(): string {
    return this.pricebook.effective_date
  }

  get quoteValidityDays(): number {
    return this.pricebook.commercial_rules.quote_validity_days
  }

  /** Included standard integrations for a capability tier. */
  includedStandardIntegrations(region: RegionCode, capability: string): number {
    const capacity = this.pricebook.regions[region].capability as Record<string, unknown>
    const tier = capacity[capability]
    if (tier === null || typeof tier !== 'object') return 0
    const value = (tier as Record<string, unknown>).included_standard_integrations
    return typeof value === 'number' ? value : 0
  }

  quote(init: QuoteRequestInit): Quote {
    const request = this.toRequest(init)
    return this.quoteRequest(request)
  }

  private toRequest(init: QuoteRequestInit): QuoteRequest {
    return {
      region: init.region,
      presence: init.presence,
      capability: init.capability,
      environment: init.environment,
      standardIntegrations: Math.max(0, init.standardIntegrations ?? 0),
      customIntegrations: Math.max(0, init.customIntegrations ?? 0),
      advancedIntegrations: Math.max(0, init.advancedIntegrations ?? 0),
      enterpriseIntegrations: Math.max(0, init.enterpriseIntegrations ?? 0),
      designAddons: init.designAddons ?? [],
      support: init.support ?? 'standard',
      usageForecast: init.usageForecast,
      annualPrepay: init.annualPrepay ?? false,
    }
  }

  quoteRequest(request: QuoteRequest): Quote {
    const selected = requireRegion(this.pricebook, request.region)
    const drivers: string[] = []

    // ---- Step A: fixed core setup -------------------------------------
    const presenceTier = selected.presence[request.presence]
    const capabilityTier = selected.capability[request.capability]
    const environmentTier = selected.environment[request.environment]
    if (!presenceTier) throw new PricingError(`Unknown presence "${request.presence}".`)
    if (!capabilityTier) throw new PricingError(`Unknown capability "${request.capability}".`)
    if (!environmentTier) throw new PricingError(`Unknown environment "${request.environment}".`)

    const presenceLine = classifyLine(presenceTier)
    const capabilityLine = classifyLine(capabilityTier)
    const environmentLine = classifyLine(environmentTier)

    const coreComponents: CoreComponent[] = [
      { name: 'presence', setup: presenceLine.setup ?? 0, countsTowardBundle: true },
    ]

    // An environment counts only when it carries a fixed price (never `from`).
    if (environmentLine.kind === 'fixed' && (environmentLine.setup ?? 0) > 0) {
      coreComponents.push({
        name: 'environment',
        setup: environmentLine.setup ?? 0,
        countsTowardBundle: true,
      })
    } else if (environmentLine.kind === 'from') {
      drivers.push(`${request.environment} is priced "from" and requires scoped custom engineering`)
    } else if (environmentLine.kind === 'custom') {
      drivers.push(`${request.environment} requires manual enterprise scoping`)
    }

    // A capability counts only when it carries a fixed price (never `custom`).
    if (capabilityLine.kind === 'fixed' && (capabilityLine.setup ?? 0) > 0) {
      coreComponents.push({
        name: 'capability',
        setup: capabilityLine.setup ?? 0,
        countsTowardBundle: true,
      })
    } else if (capabilityLine.kind === 'custom') {
      drivers.push(`${request.capability} capability requires manual scoping`)
    }

    const fixedCoreSetup = coreComponents.reduce((sum, component) => sum + component.setup, 0)
    const paidCoreComponentCount = coreComponents.filter(
      (component) => component.countsTowardBundle,
    ).length
    const discountPct = bundleDiscountPct(this.pricebook, paidCoreComponentCount)
    const discountedCoreSetup = fixedCoreSetup * (1 - discountPct / 100)

    // ---- Step C: integrations -----------------------------------------
    const included = this.includedStandardIntegrations(request.region, request.capability)
    const chargeableStandard = Math.max(0, request.standardIntegrations - included)

    const standardTierLine = classifyLine(selected.integration.standard)
    const customTierLine = classifyLine(selected.integration.custom)
    const advancedTierLine = classifyLine(selected.integration.advanced)
    const enterpriseTierLine = classifyLine(selected.integration.enterprise)

    const integrations: IntegrationLine[] = []

    if (request.standardIntegrations > 0) {
      if (standardTierLine.kind === 'fixed') {
        integrations.push({
          complexity: 'standard',
          count: chargeableStandard,
          unitSetup: standardTierLine.setup ?? null,
          total: (standardTierLine.setup ?? 0) * chargeableStandard,
          fromMinimum: false,
        })
      } else if (standardTierLine.kind === 'from') {
        // A "from" standard integration must never be presented as fixed.
        drivers.push('standard integration price is "from" and requires scoping')
        integrations.push({
          complexity: 'standard',
          count: chargeableStandard,
          unitSetup: standardTierLine.setup ?? null,
          total: null,
          fromMinimum: true,
        })
      }
    }

    for (const [complexity, count, line] of [
      ['custom', request.customIntegrations, customTierLine],
      ['advanced', request.advancedIntegrations, advancedTierLine],
    ] as const) {
      if (count <= 0) continue
      if (line.kind === 'fixed') {
        integrations.push({
          complexity,
          count,
          unitSetup: line.setup ?? null,
          total: (line.setup ?? 0) * count,
          fromMinimum: false,
        })
      } else if (line.kind === 'from') {
        drivers.push(`${count} ${complexity} integration(s) priced "from" and require scoping`)
        integrations.push({
          complexity,
          count,
          unitSetup: line.setup ?? null,
          total: null,
          fromMinimum: true,
        })
      }
    }

    if (request.enterpriseIntegrations > 0) {
      if (enterpriseTierLine.kind === 'custom') {
        drivers.push(
          `${request.enterpriseIntegrations} enterprise integration(s) require manual scoping`,
        )
        integrations.push({
          complexity: 'enterprise',
          count: request.enterpriseIntegrations,
          unitSetup: null,
          total: null,
          fromMinimum: false,
        })
      } else {
        drivers.push(
          `${request.enterpriseIntegrations} enterprise integration(s) have no pricebook line`,
        )
        integrations.push({
          complexity: 'enterprise',
          count: request.enterpriseIntegrations,
          unitSetup: null,
          total: null,
          fromMinimum: false,
        })
      }
    }

    const integrationSetupTotal = integrations.reduce((sum, line) => sum + (line.total ?? 0), 0)

    // ---- Step D: design / support add-ons ------------------------------
    const designAddons: { name: string; setup: number; from: boolean; custom: boolean }[] = []
    for (const addon of request.designAddons) {
      const line = classifyLine(selected.design_addons[addon])
      if (line.kind === 'fixed') {
        designAddons.push({ name: addon, setup: line.setup ?? 0, from: false, custom: false })
      } else if (line.kind === 'from') {
        drivers.push(`${addon} is priced "from" and requires scoping`)
        designAddons.push({ name: addon, setup: line.setup ?? 0, from: true, custom: false })
      } else {
        drivers.push(`${addon} requires manual scoping`)
        designAddons.push({ name: addon, setup: 0, from: false, custom: true })
      }
    }
    const designAddonFixedTotal = designAddons
      .filter((addon) => !addon.from)
      .reduce((sum, addon) => sum + addon.setup, 0)

    const supportLine = classifyLine(selected.support_addons[request.support])
    const supportMonthly = supportLine.kind === 'custom' ? null : (supportLine.monthly ?? 0)
    if (supportMonthly === null) {
      drivers.push(`${request.support} support requires manual scoping`)
    }

    // ---- Step E: one-time total ----------------------------------------
    const rounding =
      request.region === 'ID'
        ? this.pricebook.currency_rounding.ID
        : this.pricebook.currency_rounding.GLOBAL

    const installableTotal = discountedCoreSetup + integrationSetupTotal + designAddonFixedTotal

    const hasFromLines =
      integrations.some((line) => line.fromMinimum) ||
      designAddons.some((addon) => addon.from || addon.custom) ||
      environmentLine.kind === 'from' ||
      environmentLine.kind === 'custom' ||
      capabilityLine.kind === 'custom' ||
      supportMonthly === null ||
      request.enterpriseIntegrations > 0

    const oneTimeTotal = hasFromLines ? null : roundCurrency(request.region, installableTotal)

    // A lower bound that includes `setup_from` minimums — explicitly labelled
    // as a minimum, never as a final project price.
    const fromMinimum =
      discountedCoreSetup +
      // A `setup_from` environment floor is not a paid core component, so it is
      // not discounted and must be added explicitly to the known minimum.
      (environmentLine.kind === 'from' ? (environmentLine.setup ?? 0) : 0) +
      integrations.reduce((sum, line) => sum + (line.unitSetup ?? 0) * line.count, 0) +
      designAddons.reduce((sum, addon) => sum + addon.setup, 0)

    // ---- Step F: recurring base ----------------------------------------
    const presenceMonthly = presenceLine.monthly ?? 0
    const capabilityMonthly = capabilityLine.kind === 'custom' ? 0 : (capabilityLine.monthly ?? 0)
    const monthlyBase = presenceMonthly + capabilityMonthly + (supportMonthly ?? 0)

    // ---- Step G: usage forecast ----------------------------------------
    const usageAllowance =
      presenceTier.included_usage !== undefined
        ? {
            unit: presenceTier.included_usage.unit,
            quantity: presenceTier.included_usage.quantity,
          }
        : null
    const overage = presenceTier.overage !== undefined ? presenceTier.overage : null
    let estimatedOverage = 0
    if (request.usageForecast !== undefined && usageAllowance && overage) {
      if (request.usageForecast > usageAllowance.quantity) {
        estimatedOverage = (request.usageForecast - usageAllowance.quantity) * overage.price
      }
    }

    // ---- Step H: annual option -----------------------------------------
    const annualPlatformOption = request.annualPrepay
      ? monthlyBase *
        12 *
        (1 - this.pricebook.discount_rules.annual_recurring_prepay_discount_pct / 100)
      : null

    // `hasFromLines` is the single authority on "we cannot state a number":
    // it already covers `custom` capability/environment tiers and enterprise
    // integration volume, so re-testing them here would be dead code that
    // only *looks* like an extra guard.
    const requiresCustomQuote = hasFromLines || drivers.length > 0

    return {
      region: request.region,
      currency: selected.currency,
      presence: request.presence,
      capability: request.capability,
      environment: request.environment,
      support: request.support,
      coreComponents,
      paidCoreComponentCount,
      bundleDiscountPct: discountPct,
      fixedCoreSetup,
      discountedCoreSetup,
      integrations,
      integrationSetupTotal,
      designAddons,
      designAddonSetupTotal: designAddonFixedTotal,
      usageAllowance,
      overage: overage ? { unit: overage.unit, price: overage.price } : null,
      estimatedOverage,
      oneTimeTotal,
      monthlyBase,
      annualPlatformOption,
      deterministicSubtotal: installableTotal,
      fromMinimumTotal: fromMinimum,
      requiresCustomQuote,
      unresolvedScopeDrivers: [...new Set(drivers)],
      roundedWithIncrement: rounding,
    }
  }
}
