import { describe, expect, it } from 'vitest'
import { budgetVariant, premiumVariant, recommendedVariant, recommendScope } from '../src/index.js'
import { makeIntegration, makeIntake } from './fixtures.js'

/**
 * §14.1 variants, and the one rule that governs all three: a variant may trade
 * *work*, never *capability*. The budget variant in particular must remain a
 * valid configuration — a cheaper quote for a building that cannot book is not
 * a cheaper building.
 */
const scopeFor = (intake = makeIntake()) => recommendScope(intake)

describe('recommendedVariant', () => {
  it('carries everything the intake asked for', () => {
    const intake = makeIntake({
      customDesign: ['advanced_motion_3d'],
      support: 'priority',
      annualPrepay: true,
      expectedConversationsPerMonth: 1200,
      integrations: [makeIntegration({ name: 'Calendar', complexity: 'standard' })],
    })
    const variant = recommendedVariant(intake, scopeFor(intake))
    expect(variant.designAddons).toEqual(['advanced_motion_3d'])
    expect(variant.support).toBe('priority')
    expect(variant.annualPrepay).toBe(true)
    expect(variant.usageForecast).toBe(1200)
    expect(variant.integrations).toEqual({ standard: 1, custom: 0, advanced: 0, enterprise: 0 })
    expect(variant.omittedIntegrations).toEqual([])
  })

  it('leaves the usage forecast absent rather than defaulting it to zero', () => {
    expect(recommendedVariant(makeIntake(), scopeFor()).usageForecast).toBeUndefined()
  })

  it('repeats the scope overrides so a variant cannot rewrite them', () => {
    const intake = makeIntake({
      presence: 'chat',
      transactionMode: 'payments_only',
      compliance: ['pci_dss'],
    })
    const scope = scopeFor(intake)
    const variant = recommendedVariant(intake, scope)
    expect(variant.overrides).toEqual(scope.overrides)
  })
})

describe('budgetVariant', () => {
  it('removes work but never capability', () => {
    const intake = makeIntake({
      transactionMode: 'booking',
      actionsRequired: ['booking.create'],
      customDesign: ['advanced_motion_3d', 'custom_visual_direction'],
      support: 'dedicated_sla',
      annualPrepay: true,
      expectedConversationsPerMonth: 900,
    })
    const scope = scopeFor(intake)
    const variant = budgetVariant(intake, scope)

    expect(variant.capability).toBe('act')
    expect(variant.capability).toBe(scope.capability)
    expect(variant.environment).toBe(scope.environment)
    expect(variant.presence).toBe(scope.presence)
    expect(variant.designAddons).toEqual([])
    expect(variant.support).toBe('standard')
    expect(variant.annualPrepay).toBe(false)
    expect(variant.usageForecast).toBeUndefined()
  })

  it('drops the integrations the intake itself marked not required, and records why', () => {
    const intake = makeIntake({
      integrations: [
        makeIntegration({ name: 'Calendar', complexity: 'standard', required: true }),
        makeIntegration({ name: 'Nice to have', complexity: 'custom', required: false }),
      ],
    })
    const variant = budgetVariant(intake, scopeFor(intake))
    expect(variant.omittedIntegrations).toEqual([
      { name: 'Nice to have', reason: 'marked not required for launch' },
    ])
    expect(variant.integrations).toEqual({ standard: 1, custom: 0, advanced: 0, enterprise: 0 })
  })

  it('keeps a required integration even when it is the expensive kind', () => {
    const intake = makeIntake({
      integrations: [makeIntegration({ name: 'SAP', complexity: 'enterprise', required: true })],
    })
    const variant = budgetVariant(intake, scopeFor(intake))
    expect(variant.integrations.enterprise).toBe(1)
    expect(variant.omittedIntegrations).toEqual([])
  })
})

describe('premiumVariant', () => {
  const up = (presence: 'chat' | 'voice' | 'human'): string =>
    premiumVariant(makeIntake({ presence }), scopeFor(makeIntake({ presence }))).presence

  it('offers one presence tier above the scope, and never above human', () => {
    expect(up('chat')).toBe('voice')
    expect(up('voice')).toBe('human')
    expect(up('human')).toBe('human')
  })

  it('adds the premium design direction once, even if the client already asked for it', () => {
    const intake = makeIntake({ customDesign: ['custom_visual_direction'] })
    expect(premiumVariant(intake, scopeFor(intake)).designAddons).toEqual([
      'custom_visual_direction',
    ])
  })

  it('leaves a client already on dedicated support there rather than pushing past it', () => {
    expect(premiumVariant(makeIntake({ support: 'dedicated_sla' }), scopeFor()).support).toBe(
      'dedicated_sla',
    )
    expect(premiumVariant(makeIntake({ support: 'standard' }), scopeFor()).support).toBe('priority')
  })

  it('never raises capability or environment — premium is a presence offer', () => {
    const intake = makeIntake({ transactionMode: 'booking', actionsRequired: ['booking.create'] })
    const scope = scopeFor(intake)
    const variant = premiumVariant(intake, scope)
    expect(variant.capability).toBe(scope.capability)
    expect(variant.environment).toBe(scope.environment)
  })
})
