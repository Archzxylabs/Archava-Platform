import { describe, expect, it } from 'vitest'
import {
  HANDOFF_REASONS,
  HandoffError,
  buildHandoffContext,
  summarizeForHandoff,
  type HandoffContext,
} from '../src/index.js'

/**
 * §26 in one line: "The customer should not need to repeat the entire story."
 * These tests check that the payload which must carry the story is a closed
 * shape, that it refuses to exist when it cannot be attributed, and that its
 * summary reports what happened rather than characterising the visitor.
 */
const base: HandoffContext = {
  tenantId: 'acme-hotels',
  sessionId: 'sess_1',
  reason: 'visitor_requested',
  route: '/checkout',
  locale: 'id',
  attemptedActions: [],
  errors: [],
  summary: 'Visitor at /checkout (checkout) after 0 attempted action(s); 0 recorded error(s).',
}

describe('handoff reasons', () => {
  it('is the closed set the PRD names', () => {
    expect([...HANDOFF_REASONS]).toEqual([
      'visitor_requested',
      'capability_exceeded',
      'repeated_failure',
      'ambiguous_request',
      'transaction_risk',
      'sentiment',
    ])
  })
})

describe('buildHandoffContext', () => {
  it('passes a complete payload through unchanged', () => {
    expect(buildHandoffContext(base)).toBe(base)
  })

  it('refuses a payload with no tenant', () => {
    // A customer's story pointed at nobody is worse than no story (§23).
    expect(() => buildHandoffContext({ ...base, tenantId: '' })).toThrow(HandoffError)
  })

  it('refuses a payload with no session', () => {
    expect(() => buildHandoffContext({ ...base, sessionId: '' })).toThrow(HandoffError)
  })

  it('refuses a payload with no summary', () => {
    // An empty summary is what sends the visitor back to square one.
    expect(() => buildHandoffContext({ ...base, summary: '' })).toThrow(HandoffError)
  })

  it('carries a customerRef only when the session may share one', () => {
    const identified = buildHandoffContext({ ...base, customerRef: 'cust_9' })
    expect(identified.customerRef).toBe('cust_9')

    const anonymous = buildHandoffContext(base)
    expect('customerRef' in anonymous).toBe(false)
  })
})

describe('summarizeForHandoff', () => {
  it('lists what was tried and what broke, and nothing more', () => {
    const context = buildHandoffContext({
      ...base,
      attemptedActions: [
        {
          actionId: 'payment.initiate',
          outcome: 'denied',
          detail: 'Confirmation required via soft.',
        },
        { actionId: 'order.status.read', outcome: 'allowed' },
      ],
      errors: [{ code: 'payment_declined', message: 'Recorded at 2026-04-01T09:00:00.000Z.' }],
      entityName: 'Room 12',
    })

    const summary = summarizeForHandoff(context)

    expect(summary).toContain('payment.initiate (denied)')
    expect(summary).toContain('order.status.read (allowed)')
    expect(summary).toContain('payment_declined: Recorded at 2026-04-01T09:00:00.000Z.')
    expect(summary).toContain('Selected: Room 12.')
  })

  it('omits a section entirely when there is nothing in it', () => {
    const summary = summarizeForHandoff(base)
    expect(summary).toBe(base.summary)
    expect(summary).not.toContain('Actions attempted')
    expect(summary).not.toContain('Errors seen')
    expect(summary).not.toContain('Selected')
  })

  it('stays mechanical about a visitor who gave up', () => {
    // "Frustrated" is a guess; three denials is a fact. Only the fact goes in.
    const summary = summarizeForHandoff({
      ...base,
      reason: 'capability_exceeded',
      attemptedActions: [
        { actionId: 'admin.config.update', outcome: 'denied', detail: 'capability' },
        { actionId: 'admin.knowledge.reindex', outcome: 'denied', detail: 'capability' },
        { actionId: 'account.update', outcome: 'denied', detail: 'capability' },
      ],
    })
    expect(summary).toContain('Actions attempted')
    expect(summary.toLowerCase()).not.toContain('frustrat')
    expect(summary.toLowerCase()).not.toContain('angry')
  })

  it('never emits a form value, because the shape has nowhere to put one', () => {
    const summary = summarizeForHandoff(base)
    expect(summary).not.toMatch(/secret|password|\bemail\b/i)
  })
})
