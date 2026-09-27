/**
 * Offline fakes for this package's tests.
 *
 * Nothing here talks to a mail provider, a database, or a network. The store is
 * a Map that enforces the same atomicity a production store must, the transport
 * is a scripted responder, and the status port is a lookup that can be told to
 * answer or to stay silent. That is the point: every guarantee asserted against
 * these fakes is a guarantee about *this package's decisions*, not about any
 * vendor, and none of them is a demonstration of real delivery.
 */

import {
  type ApprovedEmailTemplate,
  type EmailAttemptClaim,
  type EmailAttemptRecord,
  type EmailAttemptSettlement,
  type EmailAttemptStore,
  type EmailDeliveryStatusLookup,
  type EmailDeliveryStatusPort,
  type EmailGateway,
  type EmailGatewayOutcome,
  type EmailSendRequest,
} from '../src/index.js'

export const TENANT_A = 'tenant-a'
export const OTHER_TENANT = 'tenant-b'
export const RECIPIENT = 'guest@example.com'
export const KEY = 'attempt-1'

export const TEMPLATE_A: ApprovedEmailTemplate = {
  tenantId: TENANT_A,
  templateId: 'receipt',
  providerTemplateId: 'provider-template-1',
  senderAddress: 'receipts@example.com',
  approved: true,
}

/** A send request for tenant A, with anything about it overridable. */
export function sendOf(overrides: Partial<EmailSendRequest> = {}): EmailSendRequest {
  return {
    tenantId: TENANT_A,
    recipient: RECIPIENT,
    template: TEMPLATE_A,
    idempotencyKey: KEY,
    ...overrides,
  }
}

/** The tenant-scoped storage key. A store that ignored the tenant would use one key. */
export function storageKey(attempt: {
  readonly tenantId: string
  readonly idempotencyKey: string
}): string {
  return JSON.stringify([attempt.tenantId, attempt.idempotencyKey])
}

/**
 * A store with the two properties a production store must supply, so that the
 * tests fail for the right reason and not because the fake was lax:
 *
 *  1. `claim` is atomic — it selects on the tenant-scoped key and writes in the
 *     same synchronous step, so two callers cannot both be told `accepted`.
 *  2. `settle` is a compare-and-swap against `from` and is durable.
 *
 * The durability half is simulated by handing the same in-memory map to a
 * *second boundary* standing in for a process that restarted, which is the only
 * thing "durable across restart" can mean in a test. This is not a guarantee a
 * production database must be coaxed into; it is the shape the production store
 * has to already have.
 */
export class RecordingStore implements EmailAttemptStore {
  readonly storeId = 'fake-durable-store'
  readonly attempts = new Map<string, EmailAttemptRecord>()
  claimCalls = 0
  settleCalls: EmailAttemptSettlement[] = []
  throwOnClaim = false
  throwOnSettle = false

  /** Overwrite one record, as a store that handed the same store to a new process would still hold it. */
  update(record: EmailAttemptRecord): void {
    this.attempts.set(storageKey(record), record)
  }

  claim(attempt: EmailAttemptRecord): Promise<EmailAttemptClaim> {
    this.claimCalls += 1
    if (this.throwOnClaim) throw new Error('store unavailable')
    const existing = this.attempts.get(storageKey(attempt))
    if (existing !== undefined) return Promise.resolve({ status: 'replayed', attempt: existing })
    // Inserted before returning. Two callers that both reached this line with an
    // empty map in one synchronous step are not a thing, which is why the atom
    // is drawn here rather than in the boundary.
    this.attempts.set(storageKey(attempt), attempt)
    return Promise.resolve({ status: 'accepted' })
  }

  settle(settlement: EmailAttemptSettlement): Promise<boolean> {
    if (this.throwOnSettle) throw new Error('store unavailable')
    const current = this.attempts.get(storageKey(settlement))
    if (current === undefined) return Promise.resolve(false)
    // The compare-and-swap. A settlement that assumed a state the record is no
    // longer in is refused, which is what stops a late "unknown" from erasing a
    // receipt that a replay has already had.
    if (current.state !== settlement.from) return Promise.resolve(false)
    this.attempts.set(storageKey(settlement), {
      ...current,
      state: settlement.state,
      providerMessageId: settlement.providerMessageId,
    })
    this.settleCalls.push(settlement)
    return Promise.resolve(true)
  }
}

/** A transport that answers the way it is told, and counts every call. */
export class FakeTransport implements EmailGateway {
  readonly calls: EmailSendRequest[] = []
  response: EmailGatewayOutcome = { outcome: 'accepted', providerMessageId: 'opaque-1' }
  throws = false

  send(request: EmailSendRequest): Promise<EmailGatewayOutcome> {
    this.calls.push(request)
    if (this.throws) return Promise.reject(new Error('the provider did not answer'))
    return Promise.resolve(this.response)
  }
}

/**
 * A status port that only knows what it is told, and never anything about the
 * payload it was asked to answer about.
 */
export class FakeStatusPort implements EmailDeliveryStatusPort {
  readonly statusPortId = 'fake-status-port'
  readonly lookups: EmailDeliveryStatusLookup[] = []
  response: EmailGatewayOutcome | null = null
  throws = false

  status(lookup: EmailDeliveryStatusLookup): Promise<EmailGatewayOutcome> {
    this.lookups.push(lookup)
    if (this.throws) return Promise.reject(new Error('status port unavailable'))
    return Promise.resolve(this.response ?? { outcome: 'unknown', reason: 'status_not_available' })
  }
}
