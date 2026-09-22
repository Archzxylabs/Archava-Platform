import { describe, expect, it } from 'vitest'
import { PricingEngine } from '../src/engine.js'

const engine = new PricingEngine()

describe('usage forecast (agent.md §12 Step G)', () => {
  it('reports zero overage when the forecast is within the allowance', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'chat',
      capability: 'assist',
      environment: 'existing_site',
      usageForecast: 800,
    })
    expect(quote.usageAllowance).toEqual({ unit: 'active_conversation', quantity: 1000 })
    expect(quote.overage).toEqual({ unit: 'active_conversation', price: 0.1 })
    expect(quote.estimatedOverage).toBe(0)
  })

  it('computes overage for the excess only', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'chat',
      capability: 'assist',
      environment: 'existing_site',
      usageForecast: 1500,
    })
    expect(quote.estimatedOverage).toBeCloseTo(50, 5)
  })

  it('uses the human-minute allowance and rate for Human presence', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'human',
      capability: 'act',
      environment: 'existing_site',
      usageForecast: 900,
    })
    expect(quote.usageAllowance).toEqual({ unit: 'realtime_human_minute', quantity: 500 })
    expect(quote.estimatedOverage).toBe(400 * 1_500)
  })

  it('does not invent an overage estimate when usage is unknown', () => {
    const quote = engine.quote({
      region: 'ID',
      presence: 'voice',
      capability: 'act',
      environment: 'existing_site',
    })
    expect(quote.estimatedOverage).toBe(0)
    expect(quote.usageAllowance?.quantity).toBe(500)
    expect(quote.overage?.price).toBe(1_000)
  })

  it('never hides overage inside the monthly base', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'voice',
      capability: 'act',
      environment: 'existing_site',
      usageForecast: 2_000,
    })
    expect(quote.monthlyBase).toBe(399 + 149)
    expect(quote.estimatedOverage).toBeGreaterThan(0)
  })
})

describe('annual prepay option (agent.md §12 Step H)', () => {
  it('applies 10% to the recurring platform fee only', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'voice',
      capability: 'act',
      environment: 'business',
      annualPrepay: true,
    })
    expect(quote.monthlyBase).toBe(548)
    expect(quote.annualPlatformOption).toBeCloseTo(548 * 12 * 0.9, 5)
  })

  it('omits the annual option unless requested', () => {
    const quote = engine.quote({
      region: 'GLOBAL',
      presence: 'voice',
      capability: 'act',
      environment: 'business',
    })
    expect(quote.annualPlatformOption).toBeNull()
  })
})
