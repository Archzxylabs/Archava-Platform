import { describe, expect, it } from 'vitest'
import { recommendScope } from '../src/index.js'
import { makeIntegration, makeIntake } from './fixtures.js'

/**
 * The recommendation is the only place the configurator decides anything, and
 * it decides by rules a person can read — so the tests assert the rules rather
 * than the tier names: every raise must be an answer that required it, and the
 * client's stated preference must survive wherever it can.
 */
describe('recommendScope', () => {
  it('keeps a stated preference when nothing requires more', () => {
    const scope = recommendScope(makeIntake({ presence: 'chat', transactionMode: 'none' }))
    expect(scope.presence).toBe('chat')
    expect(scope.capability).toBe('assist')
    expect(scope.overrides).toEqual([])
  })

  it('gives an acting assistant the act tier', () => {
    const scope = recommendScope(
      makeIntake({
        actionsRequired: ['booking.create'],
        transactionMode: 'none',
      }),
    )
    expect(scope.capability).toBe('act')
    expect(scope.overrides).toEqual([])
  })

  it('requires transact once money moves', () => {
    const cases = [
      { transactionMode: 'payments_only' as const },
      { transactionMode: 'checkout_orders' as const },
      { actionsRequired: ['payment.capture'] },
      { actionsRequired: ['refund.issue'] },
      { actionsRequired: ['subscription.upgrade'] },
    ]
    for (const request of cases) {
      expect(recommendScope(makeIntake(request)).capability, JSON.stringify(request)).toBe(
        'transact',
      )
    }
  })

  it('raises chat to voice when a payment runs under a compliance obligation', () => {
    const scope = recommendScope(
      makeIntake({
        presence: 'chat',
        transactionMode: 'payments_only',
        compliance: ['pci_dss'],
      }),
    )
    expect(scope.presence).toBe('voice')
    const override = scope.overrides.find((entry) => entry.field === 'presence')
    expect(override?.asked).toBe('chat')
    expect(override?.recommended).toBe('voice')
    expect(override?.reason).toContain('confirmation step')
  })

  it('leaves chat alone when payments carry no compliance obligation', () => {
    const scope = recommendScope(
      makeIntake({
        presence: 'chat',
        transactionMode: 'payments_only',
        compliance: ['none'],
      }),
    )
    expect(scope.presence).toBe('chat')
    expect(scope.overrides).toEqual([])
  })

  it('does not raise a client who already chose voice', () => {
    const scope = recommendScope(
      makeIntake({
        presence: 'voice',
        transactionMode: 'payments_only',
        compliance: ['gdpr'],
      }),
    )
    expect(scope.presence).toBe('voice')
    expect(scope.overrides).toEqual([])
  })

  describe('environment', () => {
    it('deploys onto whatever live site they already have', () => {
      const scope = recommendScope(
        makeIntake({
          existingWebsite: { status: 'live', url: 'https://acme.example' },
        }),
      )
      expect(scope.environment).toBe('existing_site')
    })

    it('rebuilds rather than deploying onto a stale site', () => {
      expect(recommendScope(makeIntake({ existingWebsite: { status: 'stale' } })).environment).toBe(
        'business',
      )
    })

    it('treats a site under construction as business', () => {
      expect(
        recommendScope(makeIntake({ existingWebsite: { status: 'under_construction' } }))
          .environment,
      ).toBe('business')
    })

    it('falls back to the industry default when the client has no site', () => {
      const noSite = { status: 'none' as const }
      expect(
        recommendScope(makeIntake({ existingWebsite: noSite, industry: 'ecommerce' })).environment,
      ).toBe('commerce_booking')
      expect(
        recommendScope(makeIntake({ existingWebsite: noSite, industry: 'clinic' })).environment,
      ).toBe('business')
      expect(
        recommendScope(
          makeIntake({
            existingWebsite: noSite,
            industry: 'professional_services',
          }),
        ).environment,
      ).toBe('business')
      expect(
        recommendScope(makeIntake({ existingWebsite: noSite, industry: 'restaurant' })).environment,
      ).toBe('landing')
    })

    it('explains a raise from landing to commerce, and only once', () => {
      const scope = recommendScope(
        makeIntake({
          industry: 'restaurant',
          existingWebsite: { status: 'none' },
          transactionMode: 'booking',
        }),
      )
      expect(scope.environment).toBe('commerce_booking')
      const override = scope.overrides.find((entry) => entry.field === 'environment')
      expect(override?.asked).toBe('landing')
      expect(override?.recommended).toBe('commerce_booking')
      expect(override?.reason).toContain('commerce and booking environment')
    })

    it('does not raise an environment already at or above what the transaction needs', () => {
      // The clinic default is `business`, which sits below `commerce_booking`,
      // so a booking scope does raise it — and says so.
      const raised = recommendScope(
        makeIntake({
          industry: 'clinic',
          existingWebsite: { status: 'none' },
          transactionMode: 'booking',
        }),
      )
      expect(raised.environment).toBe('commerce_booking')
      expect(raised.overrides.filter((entry) => entry.field === 'environment')).toHaveLength(1)

      // An ecommerce client already lands on commerce_booking, so no raise.
      const already = recommendScope(
        makeIntake({
          industry: 'ecommerce',
          existingWebsite: { status: 'none' },
          transactionMode: 'booking',
        }),
      )
      expect(already.environment).toBe('commerce_booking')
      expect(already.overrides.filter((entry) => entry.field === 'environment')).toEqual([])
    })
  })

  /**
   * The environment an enterprise-scale integration reaches, and why it is the
   * environment that moves rather than the capability.
   *
   * The pricebook gives `enterprise_system` no fixed setup, so raising the
   * environment keeps the monthly figure and adds an honest "requires manual
   * scoping" driver. Escalating the capability to `enterprise` would drop the
   * setup too, but it would also *erase* the monthly floor — `capability.
   * enterprise` carries no monthly line at all — and quote an engagement with
   * nothing under it.
   */
  describe('an enterprise-scale integration', () => {
    const ERP = { name: 'SAP ERP', complexity: 'enterprise' as const, required: true }

    it('moves the environment to an enterprise system, and says so', () => {
      const scope = recommendScope(makeIntake({ integrations: [ERP] }))
      expect(scope.environment).toBe('enterprise_system')

      const override = scope.overrides.find((entry) => entry.field === 'environment')
      expect(override?.asked).toBe('business')
      expect(override?.recommended).toBe('enterprise_system')
      expect(override?.reason).toContain('custom scope only')
    })

    it('names the stronger reason once rather than stacking both', () => {
      // A booking flow already wants commerce; an ERP wants more. The
      // environment ends somewhere the booking reason alone would never have
      // taken it, so that reason is dropped instead of listed under the real one.
      const scope = recommendScope(
        makeIntake({
          industry: 'ecommerce',
          existingWebsite: { status: 'none' },
          transactionMode: 'booking',
          integrations: [ERP],
        }),
      )
      expect(scope.environment).toBe('enterprise_system')

      const overrides = scope.overrides.filter((entry) => entry.field === 'environment')
      expect(overrides).toHaveLength(1)
      expect(overrides[0]?.asked).toBe('commerce_booking')
      expect(overrides[0]?.reason).toContain('enterprise')
    })

    it('ignores an integration the launch does not require', () => {
      const scope = recommendScope(
        makeIntake({
          transactionMode: 'booking',
          integrations: [{ ...ERP, required: false }],
        }),
      )
      // A nice-to-have ERP is not a reason to price the build as an enterprise
      // engagement. `variants` prices only the required integrations, so a scope
      // that counted this one would price more than it sells.
      expect(scope.environment).toBe('commerce_booking')
      expect(scope.integrations.enterprise).toBe(0)
    })

    it('takes a payment flow to enterprise capability, never below', () => {
      const scope = recommendScope(
        makeIntake({
          transactionMode: 'payments_only',
          compliance: ['pci_dss'],
          integrations: [ERP],
        }),
      )
      expect(scope.capability).toBe('enterprise')

      const override = scope.overrides.find((entry) => entry.field === 'capability')
      expect(override?.asked).toBe('transact')
      expect(override?.recommended).toBe('enterprise')
    })

    it('leaves the capability at the floor when nothing transacts', () => {
      // An ERP integration behind a booking flow still changes the environment,
      // but the assistant never moves money, so `act` is the honest capability.
      const scope = recommendScope(makeIntake({ transactionMode: 'booking', integrations: [ERP] }))
      expect(scope.capability).toBe('act')
      expect(scope.environment).toBe('enterprise_system')
    })
  })

  describe('integrations', () => {
    it('counts only the work required for launch', () => {
      const scope = recommendScope(
        makeIntake({
          integrations: [
            makeIntegration({ name: 'Calendar', complexity: 'standard' }),
            makeIntegration({ name: 'Payments', complexity: 'advanced' }),
            makeIntegration({
              name: 'Nice to have',
              complexity: 'custom',
              required: false,
            }),
          ],
        }),
      )
      expect(scope.integrations).toEqual({
        standard: 1,
        custom: 0,
        advanced: 1,
        enterprise: 0,
      })
    })
  })

  it('is deterministic across repeated runs on one intake', () => {
    const intake = makeIntake({
      presence: 'chat',
      transactionMode: 'booking',
      compliance: ['gdpr'],
      integrations: [makeIntegration({ name: 'SAP', complexity: 'enterprise' })],
    })
    expect(recommendScope(intake)).toEqual(recommendScope(intake))
  })
})
