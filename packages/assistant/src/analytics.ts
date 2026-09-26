/**
 * Analytics event catalogue (PRD §27).
 *
 * The PRD names the events; this module makes the names a closed union and gives
 * each one the payload shape it can carry. Two properties matter more than the
 * list itself:
 *
 * 1. **Every event is tenant-scoped.** An event without a `tenantId` is not a
 *    reportable event, and the type says so, because a cross-tenant analytics
 *    leak is exactly the §23 bug in a different costume.
 * 2. **Nothing here sends anything.** Emitting an event is the caller's job (a
 *    Trigger.dev workflow, §20), so this package cannot make a network call from
 *    inside a turn.
 *
 * On the action events below: an operator reading a dashboard must be able to
 * tell *"the policy said no"* from *"the policy said yes and the action then
 * failed"*. Those need different responses — the first is a configuration or
 * capability problem, the second is a broken integration. Collapsing both into
 * `tool_failure` made them indistinguishable, which is how a failed booking
 * ends up looking like a denied permission. They are separate events now, and
 * `tool_failure` keeps its original meaning: a tool the platform depends on
 * broke, as opposed to a decision anyone made.
 */

/** The PRD §27 catalogue, verbatim and in order. */
export const ANALYTICS_EVENTS = [
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
  // Action outcomes, separated by PRD §18 (V1.1). See the module header: these
  // states are genuinely different facts about the world, and a dashboard that
  // merges them hides the one that needs a human.
  'action_denied',
  'action_confirmation_required',
  'action_execution_succeeded',
  'action_execution_failed',
] as const
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number]

/** Fields every event carries, whatever its shape. */
export interface AnalyticsEventBase {
  readonly name: AnalyticsEventName
  readonly tenantId: string
  /** Conversation the event belongs to. */
  readonly sessionId: string
  /** When it happened, as an ISO timestamp the caller supplies. */
  readonly occurredAt: string
}

/** Optional dimensions a caller may attach to any event. */
export interface AnalyticsEventDetails {
  /** Action or entity the event was about, when there is one. */
  readonly subjectId?: string
  /** Result of the thing that happened: 'allowed' | 'denied' | 'failed' | … */
  readonly outcome?: string
  /** Knowledge chunks the event rested on, for §17's eval trail. */
  readonly sourceIds?: readonly string[]
  /** Presence mode actually served, when the event is a fallback. */
  readonly presenceMode?: string
  /** Free-form but bounded operator note. Never visitor PII. */
  readonly note?: string
}

export type AnalyticsEvent = AnalyticsEventBase & AnalyticsEventDetails

export class AnalyticsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalyticsError'
  }
}

/**
 * Build one event, filling the envelope.
 *
 * The tenant and session are required rather than optional: an event that cannot
 * be attributed is a §23 violation waiting to be written to a warehouse, so this
 * throws instead of producing an unattributable row.
 */
export function buildEvent(input: AnalyticsEvent): AnalyticsEvent {
  if (input.tenantId.length === 0) {
    throw new AnalyticsError(
      'An analytics event needs a tenantId; an unattributable event is not storable.',
    )
  }
  if (!ANALYTICS_EVENTS.includes(input.name)) {
    throw new AnalyticsError(`Unknown analytics event "${input.name}".`)
  }

  const event: AnalyticsEvent = {
    name: input.name,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
    ...(input.presenceMode === undefined ? {} : { presenceMode: input.presenceMode }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  return event
}

/** §17's name for "the visitor asked something the tenant's content covered". */
export const MEANINGFUL_ANSWER_EVENT: AnalyticsEventName = 'meaningful_question_answered'
/** The PRD's name for "the tenant's content did not cover this". */
export const KNOWLEDGE_GAP_EVENT: AnalyticsEventName = 'knowledge_gap'
export const PRESENCE_FALLBACK_EVENT: AnalyticsEventName = 'presence_fallback'
export const TOOL_FAILURE_EVENT: AnalyticsEventName = 'tool_failure'
/** The policy gate refused an action (PRD §18). Nobody attempted anything. */
export const ACTION_DENIED_EVENT: AnalyticsEventName = 'action_denied'
/** The gate said "not yet", and the turn is waiting on a human (PRD §18). */
export const ACTION_CONFIRMATION_REQUIRED_EVENT: AnalyticsEventName = 'action_confirmation_required'
/** An executor reported a confirmed side effect (PRD §18, V1.1). */
export const ACTION_EXECUTION_SUCCEEDED_EVENT: AnalyticsEventName = 'action_execution_succeeded'
/** An action was allowed, attempted, and the executor reported failure. */
export const ACTION_EXECUTION_FAILED_EVENT: AnalyticsEventName = 'action_execution_failed'
