/**
 * Human handoff context (PRD §26).
 *
 * "The customer should not need to repeat the entire story." That single sentence
 * is the requirement, and it is a data requirement: the handoff payload must carry
 * everything the human needs to pick up mid-conversation. So this module is a
 * closed shape, not a free-text dump.
 *
 * The payload is assembled by the platform from the context graph and the turn
 * record — never composed by the model. A model asked to "summarise the
 * conversation" is a model invited to guess at facts it was not given; the
 * summary here is the actions actually attempted and the errors actually seen.
 *
 * Two fields are deliberately absent from the shape:
 *
 * - **Sensitive values.** The handoff carries ids, labels, and field *names*. The
 *   masker in `@archava/acl` runs on field names; a form's values never reach
 *   here at all.
 * - **Anything cross-tenant.** `tenantId` is required (see §23).
 */

export const HANDOFF_REASONS = [
  'visitor_requested',
  'capability_exceeded',
  'repeated_failure',
  'ambiguous_request',
  'transaction_risk',
  'sentiment',
] as const
export type HandoffReason = (typeof HANDOFF_REASONS)[number]

/** An action the assistant already tried, and what came of it. */
export interface HandoffAttemptedAction {
  readonly actionId: string
  readonly outcome: 'allowed' | 'denied' | 'failed'
  /** Why it was denied or failed, when it was. */
  readonly detail?: string
}

/** A known UI error the visitor hit, as the context graph recorded it. */
export interface HandoffErrorRecord {
  /** Error code or short kind, e.g. 'payment_declined'. */
  readonly code: string
  readonly message: string
}

export interface HandoffContext {
  readonly tenantId: string
  readonly sessionId: string
  readonly reason: HandoffReason
  /**
   * Visitor identity where the session is permitted to share it. Absent when the
   * session is anonymous or the tenant does not expose identity.
   */
  readonly customerRef?: string
  /** Where the visitor was when they asked for a human. */
  readonly route: string
  readonly locale: string
  /** Selected entity, when one was selected. */
  readonly entityName?: string
  /** What the assistant already tried, newest last. */
  readonly attemptedActions: readonly HandoffAttemptedAction[]
  /** UI errors seen this session, newest last. */
  readonly errors: readonly HandoffErrorRecord[]
  /** Concise prose. Bounded, and assembled by the platform. */
  readonly summary: string
}

export class HandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandoffError'
  }
}

/**
 * Build a handoff payload, refusing one that cannot be attributed.
 *
 * A handoff with no tenant is not a handoff, it is a customer's story pointed at
 * nobody, so this throws rather than producing one.
 */
export function buildHandoffContext(input: HandoffContext): HandoffContext {
  if (input.tenantId.length === 0) {
    throw new HandoffError('A handoff needs a tenantId.')
  }
  if (input.sessionId.length === 0) {
    throw new HandoffError('A handoff needs a sessionId.')
  }
  if (input.summary.length === 0) {
    throw new HandoffError(
      'A handoff needs a summary; an empty one sends the story back to square one.',
    )
  }

  return input
}

/**
 * Compose the human-readable summary from the structured facts.
 *
 * Deliberately mechanical: it lists what was tried and what broke. It does not
 * attempt to characterise the visitor's mood or infer intent, because those are
 * the two things a generated summary gets wrong and the two things a human agent
 * will then act on.
 */
export function summarizeForHandoff(context: HandoffContext): string {
  const lines: string[] = [context.summary]

  if (context.attemptedActions.length > 0) {
    const tried = context.attemptedActions
      .map((attempt) => `${attempt.actionId} (${attempt.outcome})`)
      .join(', ')
    lines.push(`Actions attempted: ${tried}.`)
  }

  if (context.errors.length > 0) {
    const errors = context.errors.map((error) => `${error.code}: ${error.message}`).join('; ')
    lines.push(`Errors seen: ${errors}.`)
  }

  if (context.entityName !== undefined) {
    lines.push(`Selected: ${context.entityName}.`)
  }

  return lines.join(' ')
}
