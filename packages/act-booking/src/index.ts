/**
 * @archava/act-booking — the booking.create executor.
 *
 * One narrow thing: make a reservation in a system that can actually make one,
 * and refuse to report a booking that was not confirmed. The decision about
 * whether the action may run is not made here (§18 and §33 made it), and neither
 * is the check that the slot and the customer exist (§9 did that). This is the
 * last boundary, where an id becomes a reservation or the turn says it does not
 * know.
 */

export {
  BOOKING_ACTION,
  BOOKING_ERROR_CODES,
  BookingActionExecutor,
  type BookingActionExecutorOptions,
} from './executor.js'

export {
  isConfirmedBooking,
  gatewayReady,
  type BookingGateway,
  type BookingOutcome,
  type BookingReservationRequest,
  type ConfirmedBooking,
  type RejectedBooking,
  type UnknownBookingOutcome,
} from './gateway.js'
