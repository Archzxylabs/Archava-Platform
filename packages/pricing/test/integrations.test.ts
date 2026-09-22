import { describe, expect, it } from 'vitest'
import { PricingEngine } from '../src/engine.js'

const engine = new PricingEngine()

describe('integration allowance (agent.md §12 Step C)', () => {
  it('includes zero standard integrations for Assist', () => {
    expect(engine.includedStandardIntegrations('GLOBAL', 'assist')).toBe(0)
    expect(engine.includedStandardIntegrations('ID', 'assist')).toBe(0)
  })

  it('includes one standard integration for Act', () => {
    expect(engine.includedStandardIntegrations('GLOBAL', 'act')).toBe(1)
    expect(engine.includedStandardIntegrations('ID', 'act')).toBe(1)
  })

  it('includes two standard integrations for Transact', () => {
    expect(engine.includedStandardIntegrations('GLOBAL', 'transact')).toBe(2)
    expect(engine.includedStandardIntegrations('ID', 'transact')).toBe(2)
  })

  it('does not charge for integrations covered by the allowance', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'act',
      environment: 'business',
      standardIntegrations: 1,
    })
    expect(quote.integrationSetupTotal).toBe(0)
    expect(quote.oneTimeTotal).toBe(22_200_000)
  })

  it('charges only the excess standard integrations', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'human',
      capability: 'transact',
      environment: 'existing_site',
      standardIntegrations: 3,
    })
    expect(quote.integrations).toHaveLength(1)
    expect(quote.integrations[0]?.count).toBe(1)
    expect(quote.integrationSetupTotal).toBe(750)
  })

  it('prices custom integrations at the "from" minimum without a fixed total', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'voice',
      capability: 'act',
      environment: 'existing_site',
      customIntegrations: 2,
    })
    expect(quote.integrationSetupTotal).toBe(0)
    expect(quote.fromMinimumTotal).toBeGreaterThan(0)
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.requiresCustomQuote).toBe(true)
    expect(quote.unresolvedScopeDrivers.join(' ')).toMatch(/from/)
  })

  it('prices advanced integrations at the "from" minimum without a fixed total', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'act',
      environment: 'existing_site',
      advancedIntegrations: 1,
    })
    expect(quote.oneTimeTotal).toBeNull()
    expect(quote.fromMinimumTotal).toBeGreaterThan(0)
    expect(quote.requiresCustomQuote).toBe(true)
  })
})

describe('bundle discount does not leak into integrations', () => {
  it('applies the discount to core setup only', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'act',
      environment: 'business',
      standardIntegrations: 2,
    })
    // core discounted by 10%, integration at full list price
    expect(quote.discountedCoreSetup).toBe(22_230_000)
    expect(quote.integrationSetupTotal).toBe(2_500_000)
    expect(quote.oneTimeTotal).toBe(24_700_000)
  })
})
