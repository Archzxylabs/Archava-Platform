/**
 * The authoritative reservation-system boundary.
 *
 * A `DecisionProvider` is not consulted here, and could not be: the port it
 * speaks carries three kinds — boolean, choice, score — and not one of them can
 * say "this slot is reserved as REF-4481". Whether a slot is free, what the
 * reservation is called, and whether the write actually landed are facts a
 * booking system owns. The gateway is where this package asks for them, and it
 * is injected precisely so the deployment decides which system answers.
 *
 * Two things follow from that, and both are bugs elsewhere in a system like this:
 *
 * 1. **The request carries the idempotency key the executor was handed.** The
 *    executor cannot assume the gateway deduplicates, so a gateway that does not
 *    know the key cannot honour a replay. A gateway that ignores it must say so
 *    by returning `unknown`, never by silently double-booking.
 * 2. **The outcome is three-valued, not two.** A reservation system that times
 *    out, or answers in a way that does not confirm a write, has not said no —
 *    it has said nothing, and "nothing" is a materially different fact from
 *    "rejected". Reporting it as a booking is how a visitor is told a reservation
 *    exists that does not.
 */

/** The reservation request, scoped to one tenant. */
export interface BookingReservationRequest {
  /** The tenant the reservation belongs to. The gateway's first key. */
  readonly tenantId: string
  /** The slot to hold, already verified to exist by the §9 resolver. */
  readonly slotId: string
  /** The verified customer reference. Not a name, not a phone. */
  readonly customerRef: string
  /** Operator notes, when the caller supplied them. Never required. */
  readonly notes?: string
  /**
   * Stable across replays of the same turn, so a retry of the same attempt is
   * recognisable as one attempt.
   */
  readonly idempotencyKey: string
}

/** A reservation the authoritative system confirms it made. */
export interface ConfirmedBooking {
  readonly outcome: 'confirmed'
  /**
   * The reference *the system* issued. Not one this package minted, and not one
   * a provider chose: a reference invented here would be a booking number for a
   * booking nobody made.
   */
  readonly bookingReference: string
}

/** A reservation the authoritative system declined. */
export interface RejectedBooking {
  readonly outcome: 'rejected'
  /**
   * The system's own reason for private operational handling. The executor
   * intentionally does not echo it into visitor-visible output or error codes.
   */
  readonly reason: string
}

/**
 * A reservation whose outcome nobody knows.
 *
 * A timeout, a dropped connection, a 500, a reply that names no reference — the
 * common property being that the write may or may not have landed.
 */
export interface UnknownBookingOutcome {
  readonly outcome: 'unknown'
  /** Why it is unknown, in words an operator can act on. */
  readonly reason: string
}

export type BookingOutcome = ConfirmedBooking | RejectedBooking | UnknownBookingOutcome

/**
 * The port a booking system implements.
 *
 * Promise-returning and async by construction. A synchronous reservation is a
 * reservation whose failure nobody had to look at, which is what makes a
 * synchronous interface tempting to implement badly.
 */
export interface BookingGateway {
  /** Which system this is, for the audit trail. Not a secret. */
  readonly gatewayId: string
  /** Whether the system is reachable. `false` makes the executor decline. */
  readonly health: { readonly ready: boolean; readonly reason: string }
  reserve(request: BookingReservationRequest): Promise<BookingOutcome>
}

/**
 * Whether a reply from a gateway is a confirmed reservation.
 *
 * A narrowing helper rather than a cast, because the reply is parsed JSON that
 * crossed a boundary nothing typed: an object that says `outcome: 'confirmed'`
 * and carries no reference is not a confirmation, and treating it as one is the
 * single most dangerous line in this package.
 */
export function isConfirmedBooking(outcome: unknown): outcome is ConfirmedBooking {
  if (typeof outcome !== 'object' || outcome === null) return false
  const candidate = outcome as Record<string, unknown>
  return (
    candidate['outcome'] === 'confirmed' &&
    typeof candidate['bookingReference'] === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(candidate['bookingReference'])
  )
}

/** Whether a gateway is willing to answer right now. */
export function gatewayReady(gateway: BookingGateway): boolean {
  return gateway.health.ready === true
}
