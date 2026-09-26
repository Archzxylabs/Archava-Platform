import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_EVENTS,
  AnalyticsError,
  buildEvent,
  type AnalyticsEventName,
} from '../src/index.js'

/**
 * §27 names sixteen events and says what they are for; §18 (V1.1) adds four more
 * for action outcomes. The two properties that matter here are the ones that
 * keep a warehouse honest: every event carries its tenant, and nothing in this
 * module sends anything.
 */
describe('the event catalogue', () => {
  it('is the twenty names the PRD and §18 list, in their order', () => {
    expect([...ANALYTICS_EVENTS]).toEqual([
      'conversation_started',
      'meaningful_question_answered',
      'recommendation_shown',
      'comparison_started',
      'lead_captured',
      'booking_started',
      'booking_completed',
      'cart_action',
      'checkout_started',
      'transaction_completed',
      'receipt_sent',
      'handoff_requested',
      'handoff_completed',
      'knowledge_gap',
      'tool_failure',
      'presence_fallback',
      // Action outcomes (PRD §18, V1.1). "The policy said no" and "the policy
      // said yes and the action then failed" are different facts and need
      // different responses, so they are not one event.
      'action_denied',
      'action_confirmation_required',
      'action_execution_succeeded',
      'action_execution_failed',
    ])
  })

  it('holds no duplicate name', () => {
    expect(new Set(ANALYTICS_EVENTS).size).toBe(ANALYTICS_EVENTS.length)
  })
})

describe('buildEvent', () => {
  const envelope = {
    tenantId: 'acme-hotels',
    sessionId: 'sess_1',
    occurredAt: '2026-04-01T09:00:00.000Z',
  } as const

  it('fills the envelope the caller supplied', () => {
    const event = buildEvent({ ...envelope, name: 'conversation_started' })
    expect(event).toEqual({ name: 'conversation_started', ...envelope })
  })

  it('refuses an event with no tenant', () => {
    // An unattributable event is a §23 violation waiting to be written to a
    // warehouse, so this throws instead of producing a row nobody can scope.
    expect(() => buildEvent({ ...envelope, tenantId: '', name: 'knowledge_gap' })).toThrow(
      AnalyticsError,
    )
  })

  it('refuses an event name outside the catalogue', () => {
    expect(() => buildEvent({ ...envelope, name: 'invented_event' as AnalyticsEventName })).toThrow(
      AnalyticsError,
    )
  })

  it('keeps the optional dimensions it was given', () => {
    const event = buildEvent({
      ...envelope,
      name: 'meaningful_question_answered',
      subjectId: 'q1',
      outcome: 'retrieval',
      sourceIds: ['k1', 'k2'],
      note: 'answered from authored content',
    })
    expect(event.subjectId).toBe('q1')
    expect(event.outcome).toBe('retrieval')
    expect(event.sourceIds).toEqual(['k1', 'k2'])
    expect(event.note).toBe('answered from authored content')
  })

  it('omits a dimension that was not supplied rather than writing undefined', () => {
    // `subjectId: undefined` and an absent `subjectId` are different rows, and
    // only one of them survives a round trip through a warehouse.
    const event = buildEvent({ ...envelope, name: 'tool_failure' })
    expect('subjectId' in event).toBe(false)
    expect('outcome' in event).toBe(false)
    expect('sourceIds' in event).toBe(false)
    expect('presenceMode' in event).toBe(false)
    expect('note' in event).toBe(false)
  })

  it('records a presence fallback by the mode actually served', () => {
    // The fallback chain only means something if the event says where it landed.
    const event = buildEvent({
      ...envelope,
      name: 'presence_fallback',
      presenceMode: 'voice',
      outcome: 'degraded',
    })
    expect(event.presenceMode).toBe('voice')
    expect(event.outcome).toBe('degraded')
  })

  it('accepts every name in the catalogue', () => {
    for (const name of ANALYTICS_EVENTS) {
      expect(buildEvent({ ...envelope, name }).name).toBe(name)
    }
  })
})
