import { describe, expect, it } from 'vitest'
import { PricingEngine } from '../src/engine.js'

const engine = new PricingEngine()

describe('custom / Enterprise items never receive an invented fixed price', () => {
  it('Enterprise capability produces no fixed one-time total', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'enterprise',
      environment: 'existing_site',
    })
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.requiresCustomQuote).toBe(true)
    expect(quote.unresolvedScopeDrivers.join(' ')).toMatch(/enterprise capability/)
  })

  it('enterprise_system environment produces no fixed one-time total', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'chat',
      capability: 'act',
      environment: 'enterprise_system',
    })
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.requiresCustomQuote).toBe(true)
  })

  it('custom_web_app is quoted "from", never as a final price', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'chat',
      capability: 'act',
      environment: 'custom_web_app',
    })
    expect(quote.oneTimeTotal).toBeNull()
    // The minimum is exposed, but only as a minimum.
    expect(quote.fromMinimumTotal).toBeGreaterThanOrEqual(8_000)
    expect(quote.unresolvedScopeDrivers.join(' ')).toMatch(/custom_web_app/)
  })

  it('enterprise integrations are never priced automatically', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'act',
      environment: 'existing_site',
      enterpriseIntegrations: 1,
    })
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.requiresCustomQuote).toBe(true)
  })

  it('dedicated SLA support is flagged for manual scoping', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'chat',
      capability: 'act',
      environment: 'existing_site',
      support: 'dedicated_sla',
    })
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.monthlyBase).toBe(249 + 149)
    expect(quote.unresolvedScopeDrivers.join(' ')).toMatch(/dedicated_sla/)
  })

  it('premium avatar provider is flagged for manual scoping', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'human',
      capability: 'act',
      environment: 'existing_site',
      designAddons: ['premium_avatar_provider'],
    })
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.requiresCustomQuote).toBe(true)
  })

  it('still quotes the deterministic fixed components exactly', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'voice',
      capability: 'act',
      environment: 'business',
      enterpriseIntegrations: 1,
    })
    // Fixed components are exact even when an Enterprise line blocks the total.
    expect(quote.fixedCoreSetup).toBe(8_000)
    expect(quote.discountedCoreSetup).toBe(7_200)
    expect(quote.monthlyBase).toBe(548)
    expect(quote.oneTimeTotal).toBeNull()
  })
})

describe('discount authority', () => {
  it('only ever applies the published bundle discount tiers', () => {
    const one = engine.quote({ region: 'ID', presence: 'chat', capability: 'assist', environment: 'existing_site' })
    const two = engine.quote({ region: 'ID', presence: 'chat', capability: 'assist', environment: 'landing' })
    const three = engine.quote({ region: 'ID', presence: 'voice', capability: 'act', environment: 'business' })

    expect(one.paidCoreComponentCount).toBe(1)
    expect(one.bundleDiscountPct).toBe(0)
    expect(two.paidCoreComponentCount).toBe(2)
    expect(two.bundleDiscountPct).toBe(5)
    expect(three.paidCoreComponentCount).toBe(3)
    expect(three.bundleDiscountPct).toBe(10)
  })

  it('never applies a discretionary discount below the published bundle tier', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'act',
      environment: 'business',
      standardIntegrations: 4,
    })
    // Act includes 1 standard integration, so 3 remain chargeable.
    expect(quote.bundleDiscountPct).toBe(10)
    // Discount applies to core only; integrations stay at list price.
    expect(quote.integrationSetupTotal).toBe(7_500_000)
    expect(quote.oneTimeTotal).toBe(
      Math.round((22_230_000 + 7_500_000) / 100_000) * 100_000,
    )
  })
})
