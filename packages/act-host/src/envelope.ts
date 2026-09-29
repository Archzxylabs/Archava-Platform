/**
 * The visitor envelope — and the reading of it that cannot be smuggled past.
 *
 * A browser is not a hostile adversary by choice; it is a hostile adversary by
 * construction. Anything it sends has already been shaped by someone who can
 * open devtools, and the only safe posture is that the envelope carries *facts
 * the visitor owns* and nothing else. This module is where that posture is
 * enforced structurally rather than by checking: the reader looks at exactly
 * four known shapes, and everything else it is handed is dropped.
 *
 * What a visitor legitimately owns:
 *
 * - an utterance — the words on the page, verbatim;
 * - one action candidate — an action id and the inputs they typed;
 * - optionally, a confirmation presentation — the two strings the challenge
 *   minted, handed back exactly as issued.
 *
 * What a visitor does not own, and therefore can never contribute: the tenant,
 * the session, the time, the policy, the capability, the role, the action
 * executor, the answer to "was this confirmed", any permission token, any
 * model confidence, and any tool-call payload. All of those live in
 * {@link SERVER_OWNED_ENVELOPE_FIELDS}, and a reader that meets one of them
 * does not copy it — it records the *name* and moves on. The names are a fixed
 * constant so an audit log can report what was refused without ever carrying
 * a value the visitor supplied.
 *
 * The result of a read is a narrow object. A caller that wants the tenant has
 * to go to the host that owns it, and a caller that wants to know what was
 * refused reads {@link VisitorEnvelopeReading.dropped}. Known server-owned
 * fields are named there; unknown names become a generic marker because even
 * an object key may contain a sensitive value.
 */

/** Every field a client might send that only the server may supply. */
export const SERVER_OWNED_ENVELOPE_FIELDS: readonly string[] = [
  // Identity and scope (§23). A visitor naming a tenant is asking to be
  // served as someone else.
  'tenantId',
  'tenant',
  'tenant_id',
  'sessionId',
  'session_id',
  // Time. A visitor-chosen `occurredAt` would let a retry mint a second
  // idempotency key from an old one.
  'occurredAt',
  'occurred_at',
  'issuedAt',
  'confirmedAt',
  // Permission (§18). These are the four fields the frozen authority says are
  // granted by `ActionPolicy` and nothing else.
  'capability',
  'role',
  'policy',
  'confirmedActionIds',
  'confirmed_action_ids',
  'declinedActionIds',
  'humanApprovedActionIds',
  'human_approved_action_ids',
  'permissionToken',
  'permission_token',
  // Trusted wiring. None of these is a value a browser can supply or verify.
  'executor',
  'resolver',
  'graph',
  'brain',
  'knowledge',
  'truth',
  'confirmations',
  'confirmationService',
  'attempts',
  'digestKey',
  'clientSensitiveFields',
  // Decision-provider authority. A `DecisionProvider` grants none of the
  // frozen authority's guarantees, so its verdicts are not inputs here.
  'decisionOrchestrator',
  'decisionTruthCandidates',
  'decision',
  'modelConfidence',
  'confidence',
  // Executor payloads. A tool call is what a brain asks for, not what a
  // visitor hands a server.
  'toolCalls',
  'toolCall',
  'toolCallPayload',
]

/**
 * Why an envelope could not be read at all.
 *
 * These are structural, not semantic: a well-formed envelope carrying an action
 * the policy dislikes is refused *later*, by the host, with a different code.
 * Nothing here says anything about the content.
 */
export const VISITOR_ENVELOPE_REASONS = [
  'not_an_object',
  'utterance_invalid',
  'action_invalid',
  'confirmation_invalid',
] as const
export type VisitorEnvelopeReason = (typeof VISITOR_ENVELOPE_REASONS)[number]

/** A structural refusal to read the envelope. Carries no visitor content. */
export class VisitorEnvelopeError extends Error {
  readonly reason: VisitorEnvelopeReason

  constructor(reason: VisitorEnvelopeReason, message: string) {
    super(message)
    this.name = 'VisitorEnvelopeError'
    this.reason = reason
  }
}

/** One action candidate, as a visitor states it. Untrusted in every part. */
export interface VisitorActionCandidate {
  readonly actionId: string
  readonly inputs: Readonly<Record<string, unknown>>
}

/** The two strings a confirmation challenge minted, handed back for spending. */
export interface VisitorConfirmationPresentation {
  readonly challengeId: string
  readonly token: string
}

/**
 * Everything a visitor may contribute to one Act turn.
 *
 * Note what is absent: no tenant, no session, no permission, no confirmation
 * *verdict* — only the tokens a confirmation challenge issued. Whether those
 * tokens bind to anything is the service's question, never this type's.
 */
export interface VisitorEnvelope {
  /** The visitor's utterance, verbatim. May be empty: an action may be asked for in silence. */
  readonly utterance: string
  /** Exactly one action candidate. A second candidate is dropped, not queued. */
  readonly action: VisitorActionCandidate
  /** Present when the visitor is presenting a confirmation challenge back. */
  readonly confirmation?: VisitorConfirmationPresentation
}

/**
 * The envelope, plus the record of what the reader refused to look at.
 *
 * `dropped` is the auditable half. It names known server-owned fields and uses
 * `unrecognized_field` for all other names, so a key containing visitor data
 * cannot leak into a log.
 */
export interface VisitorEnvelopeReading {
  readonly envelope: VisitorEnvelope
  readonly dropped: readonly string[]
}

/** The most an utterance may be, in characters. A generous ceiling, enforced. */
const MAX_UTTERANCE_CHARS = 8192
/** The most an id or token may be. Mirrors the confirmation service's own cap. */
const MAX_ID_CHARS = 256

/**
 * Read an untrusted value as a {@link VisitorEnvelope}, or refuse it.
 *
 * Deliberately not a validator with warnings: an unknown field is not
 * *sanitised*, it is not read at all. The only two ways a key survives are
 * that it is one of the known shapes, or that it was dropped and reported with
 * a safe field name or a generic marker.
 */
export function readVisitorEnvelope(value: unknown): VisitorEnvelopeReading {
  if (!isPlainObject(value)) {
    throw new VisitorEnvelopeError(
      'not_an_object',
      'A visitor envelope must be a plain object of visitor-owned fields.',
    )
  }

  const dropped: string[] = []
  for (const key of Object.keys(value)) {
    if (!VISITOR_ENVELOPE_FIELDS.has(key)) {
      dropped.push(SERVER_OWNED_FIELD_SET.has(key) ? key : 'unrecognized_field')
    }
  }

  const utterance = value.utterance
  if (typeof utterance !== 'string' || utterance.length > MAX_UTTERANCE_CHARS) {
    throw new VisitorEnvelopeError(
      'utterance_invalid',
      'A visitor envelope needs an utterance of at most 8192 characters.',
    )
  }

  const action = readAction(value.action)
  const confirmation = readConfirmation(value.confirmation)

  return {
    envelope:
      confirmation === undefined ? { utterance, action } : { utterance, action, confirmation },
    dropped,
  }
}

/** The four shapes a visitor may contribute. Anything else is not a field. */
const VISITOR_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'utterance',
  'action',
  'confirmation',
])
const SERVER_OWNED_FIELD_SET: ReadonlySet<string> = new Set(SERVER_OWNED_ENVELOPE_FIELDS)

function readAction(value: unknown): VisitorActionCandidate {
  if (!isPlainObject(value)) {
    throw new VisitorEnvelopeError('action_invalid', 'A visitor action must be a plain object.')
  }
  const actionId = value.actionId
  if (!isIdLike(actionId)) {
    throw new VisitorEnvelopeError(
      'action_invalid',
      'A visitor action must name an action id of at most 256 characters.',
    )
  }
  const inputs = value.inputs
  if (!isPlainObject(inputs)) {
    throw new VisitorEnvelopeError(
      'action_invalid',
      'A visitor action must carry its inputs as a plain object.',
    )
  }
  return { actionId, inputs }
}

function readConfirmation(value: unknown): VisitorConfirmationPresentation | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    throw new VisitorEnvelopeError(
      'confirmation_invalid',
      'A visitor confirmation must be a plain object of challengeId and token.',
    )
  }
  // A presented confirmation needs both halves. A challenge id with no token
  // cannot be verified, and reporting that here rather than reaching the service
  // keeps the refusal about the envelope, where the mistake was made.
  if (!isIdLike(value.challengeId) || !isIdLike(value.token)) {
    throw new VisitorEnvelopeError(
      'confirmation_invalid',
      'A visitor confirmation must carry a challengeId and a token of at most 256 characters.',
    )
  }
  return { challengeId: value.challengeId, token: value.token }
}

/**
 * A non-empty string within the id ceiling.
 *
 * Whitespace is not rejected here on purpose: whitespace is a *content*
 * question, and the content gate (`validateActionInputs`, the policy, the
 * confirmation binding) is where content is judged. This reader's whole claim
 * is narrower — that the shape is a string, bounded, and not empty.
 */
function isIdLike(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}

/**
 * A plain object: not an array, not null, not a class instance.
 *
 * The prototype check is the part that keeps an envelope from smuggling a
 * getter-shaped object whose `Object.keys` disagrees with what a later read
 * returns, or a `Date` whose identity is a time the visitor chose.
 */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
