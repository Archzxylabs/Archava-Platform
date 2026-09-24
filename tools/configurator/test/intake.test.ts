import { describe, expect, it } from 'vitest'
import { IntakeError, parseIntake, safeParseIntake } from '../src/index.js'
import { BASE_INTAKE, makeIntake, makeIntegration } from './fixtures.js'

/**
 * The intake boundary is where a human's answers become the platform's
 * vocabulary, so the tests here are about refusal: an answer that is not on the
 * list must not become one.
 */
describe('parseIntake', () => {
  it('accepts a complete intake unchanged', () => {
    const intake = parseIntake(structuredClone(BASE_INTAKE))
    expect(intake.clientId).toBe('acme-clinic')
    expect(intake.businessGoals).toEqual(['Book appointments without phone tag'])
  })

  it('applies the documented defaults rather than guessing', () => {
    const raw = structuredClone(BASE_INTAKE) as Record<string, unknown>
    delete raw.actionsRequired
    delete raw.expectedConversationsPerMonth
    delete raw.integrations
    delete raw.compliance
    delete raw.customDesign
    delete raw.support
    delete raw.annualPrepay

    const intake = parseIntake(raw)
    expect(intake.actionsRequired).toEqual([])
    expect(intake.expectedConversationsPerMonth).toBe(0)
    expect(intake.integrations).toEqual([])
    expect(intake.compliance).toEqual(['none'])
    expect(intake.customDesign).toEqual([])
    expect(intake.support).toBe('standard')
    expect(intake.annualPrepay).toBe(false)
  })

  it('defaults an integration to required for launch', () => {
    const intake = parseIntake(
      makeIntake({
        integrations: [makeIntegration({ name: 'Google Calendar' })],
      }),
    )
    expect(intake.integrations[0]?.required).toBe(true)
  })

  it('leaves an unstated budget absent, which is not a budget of zero', () => {
    expect(parseIntake(structuredClone(BASE_INTAKE)).budget).toBeUndefined()
    expect(parseIntake(makeIntake({ budget: { amount: 0, currency: 'USD' } })).budget?.amount).toBe(
      0,
    )
  })

  it('keeps a URL optional, because a client with no site still answers', () => {
    const raw = structuredClone(BASE_INTAKE) as Record<string, unknown>
    ;(raw.existingWebsite as Record<string, unknown>).url = undefined
    expect(parseIntake(raw).existingWebsite.url).toBeUndefined()
  })

  describe('refusals', () => {
    it('rejects an unknown key rather than dropping it', () => {
      expect(() => parseIntake({ ...BASE_INTAKE, surprise: 'yes' })).toThrow(IntakeError)
      const result = safeParseIntake({ ...BASE_INTAKE, surprise: 'yes' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.issues.join('\n')).toContain('surprise')
      }
    })

    it('reports every issue at once, not the first one', () => {
      let issues: readonly string[] = []
      try {
        parseIntake({
          ...BASE_INTAKE,
          clientId: 'Not Kebab',
          languages: [{ code: 'english', label: 'English' }],
          targetLaunchDate: '02/11/2026',
          budget: { amount: -1, currency: 'GBP' },
        })
      } catch (error) {
        if (error instanceof IntakeError) issues = error.issues
      }
      // Four independent fields. The budget alone yields two reasons — a
      // negative amount and an unsupported currency — so refusing "every issue
      // at once" means five, not one.
      expect(issues).toHaveLength(5)
      expect(issues.join('\n')).toContain('clientId')
      expect(issues.join('\n')).toContain('languages.0.code')
      expect(issues.join('\n')).toContain('targetLaunchDate')
      expect(issues.join('\n')).toContain('budget')
    })

    it('refuses an answer that is not on the list', () => {
      for (const field of [
        'industry',
        'region',
        'presence',
        'transactionMode',
        'support',
      ] as const) {
        const result = safeParseIntake({ ...BASE_INTAKE, [field]: 'sort of' })
        expect(result.success, `${field} should refuse an off-list value`).toBe(false)
      }
    })

    it('refuses a fractional or negative conversation count', () => {
      for (const count of [-1, 1.5]) {
        expect(safeParseIntake(makeIntake({ expectedConversationsPerMonth: count })).success).toBe(
          false,
        )
      }
    })

    it('refuses a client id that would not survive as a tenant slug', () => {
      for (const clientId of ['Acme', '-acme', 'acme-', 'acme--clinic', 'acme clinic']) {
        expect(safeParseIntake({ ...BASE_INTAKE, clientId }).success, clientId).toBe(false)
      }
      expect(safeParseIntake({ ...BASE_INTAKE, clientId: 'a-1-b' }).success).toBe(true)
    })

    it('requires at least one language and one goal', () => {
      expect(safeParseIntake({ ...BASE_INTAKE, languages: [] }).success).toBe(false)
      expect(safeParseIntake({ ...BASE_INTAKE, businessGoals: [] }).success).toBe(false)
    })

    it('refuses a compliance need the platform has no review path for', () => {
      expect(safeParseIntake({ ...BASE_INTAKE, compliance: ['soc2'] }).success).toBe(false)
      expect(safeParseIntake({ ...BASE_INTAKE, compliance: ['hipaa'] }).success).toBe(true)
    })
  })

  it('parses the same raw value to an equal intake every time', () => {
    const raw = structuredClone(BASE_INTAKE)
    expect(parseIntake(raw)).toEqual(parseIntake(raw))
  })

  /**
   * A repeated answer is not a second one. `customDesign` and `integrations`
   * both reach the pricing engine, which charges for every entry it hands on,
   * so a duplicate here is a duplicate charge on the quote.
   */
  describe('repeated answers', () => {
    it('keeps a design addon the client listed twice, once', () => {
      const intake = parseIntake(
        makeIntake({ customDesign: ['custom_visual_direction', 'custom_visual_direction'] }),
      )
      expect(intake.customDesign).toEqual(['custom_visual_direction'])
    })

    it('keeps the compliance obligations and actions distinct', () => {
      const intake = parseIntake(
        makeIntake({
          compliance: ['gdpr', 'gdpr', 'hipaa'],
          actionsRequired: ['booking.create', 'booking.create'],
        }),
      )
      expect(intake.compliance).toEqual(['gdpr', 'hipaa'])
      expect(intake.actionsRequired).toEqual(['booking.create'])
    })

    it('keeps one entry per language code, not per duplicated row', () => {
      const intake = parseIntake(
        makeIntake({
          languages: [
            { code: 'en', label: 'English' },
            { code: 'en', label: 'English' },
            { code: 'id', label: 'Indonesian' },
          ],
        }),
      )
      expect(intake.languages).toEqual([
        { code: 'en', label: 'English' },
        { code: 'id', label: 'Indonesian' },
      ])
    })

    it('keeps the first copy of a stated business goal', () => {
      const intake = parseIntake(makeIntake({ businessGoals: ['Grow', 'Grow'] }))
      expect(intake.businessGoals).toEqual(['Grow'])
    })

    /**
     * The one list that refuses rather than collapses: two rows both called
     * "Google Calendar" could disagree about complexity, and which one survived
     * would decide the price.
     */
    it('refuses two integrations with the same name', () => {
      const result = safeParseIntake(
        makeIntake({
          integrations: [
            makeIntegration({ name: 'Google Calendar', complexity: 'standard' }),
            makeIntegration({ name: 'Google Calendar', complexity: 'enterprise' }),
          ],
        }),
      )
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.issues.join('\n')).toContain('integrations')
      }
    })

    it('accepts distinct integration names that share a complexity', () => {
      const result = safeParseIntake(
        makeIntake({
          integrations: [
            makeIntegration({ name: 'Google Calendar' }),
            makeIntegration({ name: 'Outlook Calendar' }),
          ],
        }),
      )
      expect(result.success).toBe(true)
    })
  })
})
