/**
 * The booking.create executor: where "allowed" becomes "reserved" — or does not.
 *
 * Everything before this was a question about permission and shape. PRD §18 and
 * §33 decided whether the action *may* run; §9 verified the `slotId` and the
 * `customerRef` against an authoritative resolver. This module answers the only
 * question either of them cannot: did the reservation actually happen.
 *
 * So the success condition is a sentence, not a checkmark. `succeeded` is
 * returned for exactly one thing — a confirmed reservation from an injected
 * authoritative gateway carrying a reference that gateway issued. Every other
 * path is a failure, and the reason is machine-readable so a caller can decide
 * what to do next.
 *
 * Four refusals matter more than the happy path:
 *
 * 1. **Any other action.** The executor dispatches `booking.create` and nothing
 *    else. `booking.reschedule` is a different id with different inputs, and an
 *    executor that "helpfully" handled a neighbour would be an action registry
 *    that lies about what is registered.
 * 2. **Only the contract's fields reach the gateway.** The gateway receives
 *    exactly what the validated contract named: a slot, a customer, notes. A
 *    gateway call containing a price, a date, or a status would mean a value
 *    nobody validated decided a reservation.
 * 3. **`unknown` is never a booking.** A timeout is not a confirmation. This is
 *    the failure the whole three-valued outcome exists to prevent: reporting an
 *    unverified reservation as a verified one is worse than refusing, because
 *    the visitor is then told a booking exists.
 * 4. **An exception is caught, not rethrown.** A booking system that throws must
 *    not take the turn pipeline down with it, and must not surface a stack to a
 *    surface a visitor reads.
 *
 * `retryable` is false everywhere. That is not pessimism: `booking.create` is
 * `idempotent: true` in the registry, so a caller may replay the same
 * `idempotencyKey` and the gateway is the thing that recognises it. An automatic
 * blind retry of an action with an unknown outcome — where the write may already
 * have landed — is the double-booking this package exists to prevent.
 */

import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
} from '@archava/assistant'

import { isConfirmedBooking } from './gateway.js'
import type { BookingGateway, BookingReservationRequest } from './gateway.js'

/** The one action this executor dispatches. */
export const BOOKING_ACTION = 'booking.create'

/** Machine-readable failure codes, so a caller can branch without string matching. */
export const BOOKING_ERROR_CODES = {
  unsupportedAction: 'booking_action_not_dispatched',
  malformedInput: 'booking_input_malformed',
  gatewayNotReady: 'booking_gateway_not_ready',
  gatewayFailed: 'booking_gateway_failed',
  gatewayUnavailable: 'booking_outcome_unknown',
  incompleteConfirmation: 'booking_confirmation_incomplete',
  declined: 'booking_declined',
} as const

/** What the executor hands a gateway, read off a validated request. */
interface BookingGatewayCall {
  readonly tenantId: string
  readonly slotId: string
  readonly customerRef: string
  readonly notes?: string
  readonly idempotencyKey: string
}

/**
 * A gateway that threw, as an outcome.
 *
 * A fourth value, distinct from `outcome: 'unknown'`: the gateway answered and
 * the *answer* was an error, which is an operational signal a caller can page
 * on. It is structurally impossible for either to be mistaken for a booking,
 * because neither is an `outcome` the gateway's own type offers.
 */
export interface BookingActionExecutorOptions {
  readonly gateway: BookingGateway
}

/**
 * The executor, as an object satisfying the existing `ActionExecutor` port.
 *
 * It adds no authority of its own. It holds a gateway, checks that the action is
 * the one it dispatches, hands the gateway exactly the validated fields, and
 * turns the three-valued outcome into either a success or a safe failure.
 */
export class BookingActionExecutor implements ActionExecutor {
  readonly executorId = 'booking.create@1'
  private readonly gateway: BookingGateway

  constructor(options: BookingActionExecutorOptions) {
    this.gateway = options.gateway
  }

  async execute(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
    if (request.action !== BOOKING_ACTION) {
      return {
        status: 'failed',
        errorCode: BOOKING_ERROR_CODES.unsupportedAction,
        retryable: false,
        message: 'This executor cannot run the requested action.',
      }
    }

    const call = readBookingCall(request)
    if (call === null) {
      return {
        status: 'failed',
        errorCode: BOOKING_ERROR_CODES.malformedInput,
        retryable: false,
        message: 'this request is not one an executor can act on, and nothing was reserved',
      }
    }

    let ready = false
    try {
      ready = this.gateway.health.ready === true
    } catch {
      ready = false
    }
    if (!ready) {
      return {
        status: 'failed',
        errorCode: BOOKING_ERROR_CODES.gatewayNotReady,
        retryable: false,
        message: 'The booking system is unavailable.',
      }
    }

    const outcome = await this.reserve(call)
    return toExecutionResult(outcome)
  }

  /**
   * Ask the gateway, and turn anything it throws into a safe failure.
   *
   * The catch is the point. A rejected promise from a booking system is a normal
   * event, not a crash: the turn survives, the action is reported as failed, and
   * a caller can read which operational class it was from the error code.
   *
   * The gateway's own words do not travel into the result. A booking system is
   * free to put a tenant id in an exception message, and `ActionExecutionResult`
   * promises a message that "must not carry tenant data" — so the detail belongs
   * to the gateway's logs, and what crosses this boundary is the class.
   */
  private async reserve(call: BookingGatewayCall): Promise<unknown> {
    const reservation: BookingReservationRequest = {
      tenantId: call.tenantId,
      slotId: call.slotId,
      customerRef: call.customerRef,
      ...(call.notes === undefined ? {} : { notes: call.notes }),
      idempotencyKey: call.idempotencyKey,
    }
    try {
      return await this.gateway.reserve(reservation)
    } catch {
      return { failed: true }
    }
  }

  /** Which gateway this executor is bound to. For a trace, and for a test. */
  get gatewayId(): string {
    return this.gateway.gatewayId
  }
}

/**
 * Read the validated fields off a request, or null when they are not there.
 *
 * A refusal rather than a repair. The inputs were already validated by §9 before
 * they reached here, so a value missing now means the request did not go through
 * validation — and the correct response to a request that skipped validation is
 * not to guess what the field would have been.
 *
 * Only the contract's fields are read: `tenantId` from the request, `slotId` and
 * `customer.customerRef` from the inputs, and `customer.notes` when present.
 * Nothing else is carried, which is what stops a stray `price` or `status` a
 * model supplied from reaching a reservation.
 */
function readBookingCall(request: ActionExecutionRequest): BookingGatewayCall | null {
  if (
    typeof request.tenantId !== 'string' ||
    request.tenantId.trim() === '' ||
    typeof request.sessionId !== 'string' ||
    request.sessionId.trim() === '' ||
    typeof request.idempotencyKey !== 'string' ||
    request.idempotencyKey.trim() === '' ||
    typeof request.inputs !== 'object' ||
    request.inputs === null ||
    Array.isArray(request.inputs)
  )
    return null
  const inputs = request.inputs
  const slotId = inputs['slotId']
  const customer = inputs['customer']
  if (typeof slotId !== 'string' || slotId.trim() === '') return null
  if (typeof customer !== 'object' || customer === null) return null
  const fields = customer as Record<string, unknown>
  const customerRef = fields['customerRef']
  if (typeof customerRef !== 'string' || customerRef.trim() === '') return null
  const notes = fields['notes']
  if (notes !== undefined && (typeof notes !== 'string' || notes.trim() === '')) return null
  return {
    tenantId: request.tenantId,
    slotId,
    customerRef,
    ...(notes === undefined ? {} : { notes }),
    idempotencyKey: request.idempotencyKey,
  }
}

/** The three-valued outcome, as an execution result. */
function toExecutionResult(outcome: unknown): ActionExecutionResult {
  if (typeof outcome === 'object' && outcome !== null && 'failed' in outcome) {
    return {
      status: 'failed',
      errorCode: BOOKING_ERROR_CODES.gatewayFailed,
      retryable: false,
      message: 'the booking system failed while answering, and no reservation is reported',
    }
  }
  if (typeof outcome !== 'object' || outcome === null) {
    return {
      status: 'failed',
      errorCode: BOOKING_ERROR_CODES.incompleteConfirmation,
      retryable: false,
      message: 'The booking system did not return a verified reservation.',
    }
  }
  const reply = outcome as Record<string, unknown>
  if (reply['outcome'] === 'rejected') {
    // Even a machine-shaped provider reason could contain tenant data. Keep
    // the public error code flat; private service telemetry can retain detail.
    return {
      status: 'failed',
      errorCode: BOOKING_ERROR_CODES.declined,
      retryable: false,
      message: 'the booking system declined this reservation',
    }
  }
  // Not `retryable: true`, on purpose. A caller that wants to try again must
  // replay the same `idempotencyKey`, which the gateway can deduplicate; a blind
  // retry after a timeout is the double-booking path.
  if (reply['outcome'] === 'unknown') {
    return {
      status: 'failed',
      errorCode: BOOKING_ERROR_CODES.gatewayUnavailable,
      retryable: false,
      message: 'the booking system did not confirm this reservation, so no booking is reported',
    }
  }
  // A reply claiming `confirmed` with no reference is not a confirmation, and
  // this is where the two are told apart. Without it a gateway bug — or a
  // malicious reply — could put a `succeeded` on a turn with no booking behind it.
  if (!isConfirmedBooking(outcome)) {
    return {
      status: 'failed',
      errorCode: BOOKING_ERROR_CODES.incompleteConfirmation,
      retryable: false,
      message:
        'the booking system answered without a reservation reference, so nothing is reported',
    }
  }
  return {
    status: 'succeeded',
    output: { bookingReference: outcome.bookingReference, status: 'confirmed' },
  }
}
