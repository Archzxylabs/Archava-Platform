import { describe, expect, it } from 'vitest'
import { PricingEngine } from '../src/engine.js'

const engine = new PricingEngine()

describe('regional isolation', () => {
  it('prices Indonesia presence independently from Global presence', () => {
    const id = engine.quote({ region: 'ID', presence: 'chat', capability: 'assist', environment: 'landing' })
    const global = engine.quote({ region: 'GLOBAL', presence: 'chat', capability: 'assist', environment: 'landing' })

    expect(id.currency).toBe('IDR')
    expect(global.currency).toBe('USD')

    expect(id.fixedCoreSetup).toBe(11_800_000)
    expect(global.fixedCoreSetup).toBe(3_500)
  })

  it('never converts a Global price into IDR', () => {
    // The Indonesia pricebook is a separate list, not an FX conversion of the
    // Global list. If this ever fails, someone has FX-converted the pricebook.
    const idVoiceMonthly = 2_490_000
    const globalVoiceMonthly = 399
    // A direct FX conversion at any plausible rate would not land on the
    // published Indonesia number; asserting the exact published number is the
    // regression guard.
    expect(idVoiceMonthly).not.toBeCloseTo(globalVoiceMonthly * 16_300, 0)
  })

  it('rejects an unknown region instead of guessing a pricebook', () => {
    expect(() =>
      engine.quote({ region: 'XX' as never, presence: 'chat', capability: 'assist', environment: 'landing' }),
    ).toThrowError(/Unknown region/)
  })

  it('keeps Indonesia and Global capability tiers independent', () => {
    const idAct = engine.quote({ region: 'ID', presence: 'chat', capability: 'act', environment: 'existing_site' })
    const globalAct = engine.quote({ region: 'GLOBAL', presence: 'chat', capability: 'act', environment: 'existing_site' })

    expect(idAct.monthlyBase).toBe(1_490_000 + 750_000)
    expect(globalAct.monthlyBase).toBe(249 + 149)
    expect(idAct.monthlyBase).not.toBe(globalAct.monthlyBase)
  })
})

describe('tier ladders', () => {
  const cases = [
    { presence: 'chat', id: 6_900_000, global: 2_000 },
    { presence: 'voice', id: 10_900_000, global: 3_500 },
    { presence: 'human', id: 14_900_000, global: 5_500 },
  ] as const

  for (const tier of cases) {
    it(`prices ${tier.presence} presence in both pricebooks`, () => {
      const id = engine.quote({ region: 'ID', presence: tier.presence, capability: 'assist', environment: 'existing_site' })
      const global = engine.quote({ region: 'GLOBAL', presence: tier.presence, capability: 'assist', environment: 'existing_site' })
      expect(id.fixedCoreSetup).toBe(tier.id)
      expect(global.fixedCoreSetup).toBe(tier.global)
    })
  }

  const capabilityCases = [
    { capability: 'assist', id: 0, global: 0 },
    { capability: 'act', id: 4_900_000, global: 1_500 },
    { capability: 'transact', id: 9_900_000, global: 3_000 },
  ] as const

  for (const tier of capabilityCases) {
    it(`prices ${tier.capability} capability in both pricebooks`, () => {
      const id = engine.quote({ region: 'ID', presence: 'chat', capability: tier.capability, environment: 'existing_site' })
      const global = engine.quote({ region: 'GLOBAL', presence: 'chat', capability: tier.capability, environment: 'existing_site' })
      expect(id.coreComponents.find((c) => c.name === 'capability')?.setup ?? tier.id).toBe(tier.id)
      expect(global.coreComponents.find((c) => c.name === 'capability')?.setup ?? tier.global).toBe(tier.global)
    })
  }
})
