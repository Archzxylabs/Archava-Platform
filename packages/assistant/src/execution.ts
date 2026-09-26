/**
 * Action execution: the boundary where "allowed" becomes "done".
 *
 * PRD §18 decides whether an action *may* run. It says nothing about whether it
 * *did*. Conflating the two is how a platform ends up telling an operator that
 * a booking was created when no booking system was ever called — so the two are
 * separate fields here, and the only thing that can turn `not_attempted` into
 * `succeeded` is an {@link ActionExecutor} returning success.
 *
 * The port is async. A real executor calls a booking system, a payment provider,
 * an email service — all network IO. A pipeline that pretended that IO was
 * synchronous would have to lie somewhere: either block an event loop or drop
 * the await and describe an outcome it never saw. Determinism comes from the
 * request being fully described (tenant, session, action, inputs, idempotency
 * key) and from nothing reading a clock or a random source, not from pretending
 * the IO is instant.
 */

import type { DenialReason } from '@archava/acl'

/** The vocabulary an executor is allowed to answer in. */
export const EXECUTION_STATUSES = ['succeeded', 'failed'] as const
export type ActionExecutionStatus = (typeof EXECUTION_STATUSES)[number]

/** What the policy gate permitted. Never implies a side effect. */
export const POLICY_DECISIONS = ['allowed', 'confirmation_required', 'denied'] as const
export type PolicyDecision = (typeof POLICY_DECISIONS)[number]

/**
 * What the pipeline knows about the side effect.
 *
 * `not_attempted` is the important one: it is what an allowed-but-unexecuted
 * action reports, and what every denied action reports. Nothing that returned
 * `not_attempted` may be described downstream as having run.
 */
export const EXECUTION_STATES = ['not_attempted', 'succeeded', 'failed'] as const
export type ExecutionState = (typeof EXECUTION_STATES)[number]

/** A fully described request for one side effect. */
export interface ActionExecutionRequest {
  /**
   * The tenant the side effect belongs to. Scoping every downstream call to it
   * is the executor's job: one tenant's action must never reach another's data.
   */
  readonly tenantId: string
  readonly sessionId: string
  /** The registry id of the action, e.g. `booking.create`. */
  readonly action: string
  /**
   * Already validated, already redacted. An executor must never have to guess
   * whether what it received was checked.
   */
  readonly inputs: Readonly<Record<string, unknown>>
  /**
   * Stable across replays of the *same turn*. A repeated request carrying the
   * same key is the same attempt, not a second one — but the caller has to
   * supply the same `occurredAt` for that to be true, so two turns asking the
   * same thing two minutes apart are two keys and two attempts, as they should
   * be. Deduplication is the executor's job, not this key's: it is carried to a
   * port that can recognise it, and nothing in this pipeline keeps the set of
   * keys it has seen.
   */
  readonly idempotencyKey: string
}

/** A discriminated outcome: either a result, or a reason there is none. */
export type ActionExecutionResult =
  | {
      readonly status: 'succeeded'
      readonly output: Readonly<Record<string, unknown>>
    }
  | {
      readonly status: 'failed'
      /** Machine-readable, so a caller can decide whether to retry. */
      readonly errorCode: string
      readonly retryable: boolean
      /** Human-readable and safe to surface. Must not carry tenant data. */
      readonly message: string
    }

/** The port a production system implements; the reference slice supplies a fake. */
export interface ActionExecutor {
  readonly executorId: string
  execute(request: ActionExecutionRequest): Promise<ActionExecutionResult>
}

/** A gated action: the policy verdict beside the execution truth. */
export interface GatedAction {
  readonly actionId: string
  /** What the gate permitted. */
  readonly policy: PolicyDecision
  /** What actually happened. `not_attempted` is the absence of a claim. */
  readonly execution: ExecutionState
  readonly inputs: Readonly<Record<string, unknown>>
  /** Present when `policy === 'confirmation_required'`. */
  readonly prompt?: string
  /** Present whenever the action was not executed, explaining why. */
  readonly reason?: string
  /**
   * Present when the *gate* denied it, and the machine-readable name of which
   * denial it was.
   *
   * The counterpart of `errorCode` on the execution side, and for the same
   * reason: `reason` is a sentence an operator reads, and a page that has to
   * react to a refusal — a card that must stop offering a booking, an audit log
   * that has to count how many visitors declined — cannot match on prose that
   * also carries a deprecation note. So the gate's own reason code travels
   * beside the sentence, and the two can never disagree because only the gate
   * writes it. An action the gate permitted and §9 validation then refused is
   * denied too, but by a later question, and carries no gate code.
   */
  readonly denialReason?: DenialReason
  /** Present for every action whose execution was attempted. */
  readonly idempotencyKey?: string
  readonly output?: Readonly<Record<string, unknown>>
  readonly errorCode?: string
  readonly retryable?: boolean
}

/** True only when an executor reported success for this action. */
export function actionExecuted(action: GatedAction): boolean {
  return action.policy === 'allowed' && action.execution === 'succeeded'
}

/**
 * The key that makes a replay a replay.
 *
 * Derived from everything that identifies the *attempt*: which tenant, which
 * session, which moment in that session's conversation, which action, and a
 * canonical form of the inputs. Canonical means keys sorted, so two objects
 * carrying the same content but not the same insertion order produce the same
 * key — otherwise `{a:1,b:2}` and `{b:2,a:1}` would read as two different
 * bookings and a re-submitted form would duplicate itself.
 *
 * What that guarantees is narrower than it looks, and the boundary is
 * `occurredAt`. Re-running this pipeline with the same request produces the
 * same key, which is what makes a *same-turn* replay recognisable. It does not
 * span turns: a confirmation clicked in a later turn carries that turn's
 * timestamp and therefore a different key — correctly, because a visitor asking
 * for the same room again tomorrow has made a new request and must not be
 * refused as a duplicate of the old one. An executor that wants to collapse a
 * double-clicked confirmation can do so on (tenant, session, action, inputs),
 * all of which it already has; the key's job is to say "this is the attempt you
 * already saw", not to decide how long an executor remembers an attempt.
 *
 * The parts are framed by JSON rather than joined on a separator. `'|'` is a
 * character a tenant id, a session id or a timestamp is allowed to contain —
 * `createSession` trims `tenantId` and nothing more, and a host page passes any
 * `sessionId` it likes — and a plain join is not length-prefixed, so one part's
 * delimiter is free to slide the boundary between it and the next. That is not
 * hypothetical: `tenantId: 'acme|x'` with `sessionId: 's1'` and `tenantId:
 * 'acme'` with `sessionId: 'x|s1'` produced byte-identical keys, so an executor
 * doing what it was told would have applied one tenant's side effect to the
 * other, and anything reading the key back by splitting on `'|'` would file the
 * record under a tenant that never asked. JSON string escaping is a bijection,
 * so no part's content can impersonate a boundary, and `JSON` is a format
 * nothing here has to parse to keep working.
 */
export function buildIdempotencyKey(request: {
  readonly tenantId: string
  readonly sessionId: string
  readonly occurredAt: string
  readonly actionId: string
  readonly inputs: Readonly<Record<string, unknown>>
}): string {
  // One `JSON.stringify` over the whole identifying record, with the same
  // replacer that canonicalises `inputs` also canonicalising the record's own
  // keys — so the key does not depend on which order the fields were written in
  // at the call site either. The inputs are serialised *inside* the frame rather
  // than alongside it, which keeps a JSON payload from ever being read as a
  // separator, and is what makes the key a single structure an executor could
  // hash rather than a sentence it has to trust not to be ambiguous.
  return JSON.stringify(request, canonicalReplacer)
}

/**
 * `JSON.stringify` with every object's keys visited in sorted order.
 *
 * Arrays keep their order — `['a','b']` and `['b','a']` are genuinely different
 * requests — but object key order is an artefact of how a value was built, not
 * part of the data.
 */
function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    sorted[key] = source[key]
  }
  return sorted
}

/** The failure an executor returns when asked for something it cannot do. */
export function executionFailure(
  errorCode: string,
  message: string,
  retryable = false,
): ActionExecutionResult {
  return { status: 'failed', errorCode, retryable, message }
}

/** The success an executor returns once the side effect is confirmed. */
export function executionSuccess(
  output: Readonly<Record<string, unknown>> = {},
): ActionExecutionResult {
  return { status: 'succeeded', output }
}
