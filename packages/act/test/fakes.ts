/**
 * In-memory doubles for the composition tests.
 *
 * They exist to prove the composition seam, not to be production stores: the
 * `claim` implementations below are deliberately *not* atomic across processes,
 * which is exactly why the real ports document that a production deployment
 * must supply durable ones. Nothing here is wired into anything but these tests.
 */

import type {
  ApprovedEmailTemplate,
  EmailAttemptRecord,
  EmailAttemptStore,
  EmailDeliveryStatusPort,
  EmailGateway,
  EmailGatewayOutcome,
  EmailSendRequest,
} from '@archava/act-email'
import type {
  BookingAttemptRecord,
  BookingAttemptStore,
  BookingGateway,
  BookingOutcome,
  BookingReconciliationPort,
  BookingReservationRequest,
} from '@archava/act-booking'

export const TENANT = 'pilot-hotel'
export const OTHER_TENANT = 'other-hotel'
export const TEMPLATE_ID = 'booking-confirmation'
export const FINGERPRINT_KEY = new Uint8Array(32).fill(7)

export const TEMPLATE: ApprovedEmailTemplate = {
  tenantId: TENANT,
  templateId: TEMPLATE_ID,
  providerTemplateId: 'trusted-template',
  senderAddress: 'receipts@example.com',
  approved: true,
}

/** A booking gateway that records what it was asked, and answers what it is told. */
export function fakeBookingGateway(reply: BookingOutcome): {
  gateway: BookingGateway
  calls: BookingReservationRequest[]
} {
  const calls: BookingReservationRequest[] = []
  return {
    calls,
    gateway: {
      gatewayId: 'fake-booking-system',
      health: { ready: true, reason: 'ready' },
      reserve(request) {
        calls.push(request)
        return Promise.resolve(reply)
      },
    },
  }
}

/** A store whose `claim` answers with whatever is already under the key. */
export function fakeBookingStore(): {
  store: BookingAttemptStore
  records: BookingAttemptRecord[]
  claims: string[]
} {
  const records: BookingAttemptRecord[] = []
  const claims: string[] = []
  return {
    records,
    claims,
    store: {
      storeId: 'fake-booking-store',
      claim(attempt) {
        claims.push(attempt.idempotencyKey)
        const existing = records.find(
          (record) =>
            record.tenantId === attempt.tenantId &&
            record.idempotencyKey === attempt.idempotencyKey,
        )
        if (existing !== undefined)
          return Promise.resolve({ status: 'replayed', attempt: existing })
        records.push(attempt)
        return Promise.resolve({ status: 'accepted' })
      },
      settle(settlement) {
        const index = records.findIndex(
          (record) =>
            record.tenantId === settlement.tenantId &&
            record.idempotencyKey === settlement.idempotencyKey,
        )
        const held = index < 0 ? undefined : records[index]
        // Unreachable through the boundary, which always claims before it
        // settles. Loud rather than invented: a store that answered for a key it
        // had never been asked to claim could only be answering about somebody
        // else's attempt, and the one reply that is honest is this one.
        if (held === undefined) {
          throw new Error('no attempt was ever claimed under this key')
        }
        if (held.state !== 'in_flight') {
          return Promise.resolve({ status: 'stale', attempt: held })
        }
        records[index] = {
          ...held,
          state: settlement.state,
          bookingReference: settlement.bookingReference,
        }
        return Promise.resolve({ status: 'settled' })
      },
    },
  }
}

/** The read-only answer about an attempt nobody has a reply for. */
export function fakeReconciler(reply: BookingOutcome): BookingReconciliationPort {
  return {
    reconcilerId: 'fake-reconciler',
    reconcile() {
      return Promise.resolve(reply)
    },
  }
}

/** A mail transport that records what it was asked, and answers what it is told. */
export function fakeEmailGateway(reply: EmailGatewayOutcome): {
  gateway: EmailGateway
  calls: EmailSendRequest[]
} {
  const calls: EmailSendRequest[] = []
  return {
    calls,
    gateway: {
      send(request) {
        calls.push(request)
        return Promise.resolve(reply)
      },
    },
  }
}

export function fakeEmailStore(): {
  store: EmailAttemptStore
  records: EmailAttemptRecord[]
} {
  const records: EmailAttemptRecord[] = []
  return {
    records,
    store: {
      storeId: 'fake-email-store',
      claim(attempt) {
        const existing = records.find(
          (record) =>
            record.tenantId === attempt.tenantId &&
            record.idempotencyKey === attempt.idempotencyKey,
        )
        if (existing !== undefined)
          return Promise.resolve({ status: 'replayed', attempt: existing })
        records.push(attempt)
        return Promise.resolve({ status: 'accepted' })
      },
      settle(settlement) {
        const record = records.find(
          (candidate) =>
            candidate.tenantId === settlement.tenantId &&
            candidate.idempotencyKey === settlement.idempotencyKey,
        )
        if (record === undefined || record.state !== 'prepared') return Promise.resolve(false)
        records.splice(records.indexOf(record), 1, {
          ...record,
          state: settlement.state,
          providerMessageId: settlement.providerMessageId,
        })
        return Promise.resolve(true)
      },
    },
  }
}

export function fakeStatusPort(reply: EmailGatewayOutcome): EmailDeliveryStatusPort {
  return {
    statusPortId: 'fake-status-port',
    status() {
      return Promise.resolve(reply)
    },
  }
}

/** The tenant's approved templates, as server configuration would read them. */
export function fakeTemplateResolver(
  available: Readonly<Record<string, ApprovedEmailTemplate>> = { [TEMPLATE_ID]: TEMPLATE },
) {
  const calls: Array<{ tenantId: string; templateId: string }> = []
  return {
    calls,
    resolver: {
      resolve(tenantId: string, templateId: string): Promise<ApprovedEmailTemplate | null> {
        calls.push({ tenantId, templateId })
        const found = available[templateId]
        if (found === undefined || tenantId !== TENANT) return Promise.resolve(null)
        return Promise.resolve(found)
      },
    },
  }
}
