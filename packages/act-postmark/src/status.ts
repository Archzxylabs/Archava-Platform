/**
 * The read-only status port for Postmark — which reports nothing yet.
 *
 * The outbox ({@link EmailDeliveryStatusPort} in `packages/act-email`) asks one
 * narrow question of a status port: *what did the provider already decide about
 * this attempt?* It asks when a record is `prepared` or `unknown`, it asks
 * through a read, and it is the only thing that may speak for a message whose
 * fate is open. It is deliberately the reason *not* to send.
 *
 * Postmark's Messages API supports an outbound search filtered by one metadata
 * field. A uniquely matched label may help a future positive-only recovery
 * flow, but the API does not promise that a search miss proves non-send: search
 * visibility, pagination, and retention leave that question open. This port
 * has not implemented or validated a tenant-bound positive lookup. Reading a
 * search miss as "not sent" would be the inference that produces a duplicate.
 *
 * So this port answers `unknown`, always, and says why. That is the honest
 * answer and the outbox already knows how to receive it: `status_not_available`
 * is one of the few provider reasons the outbox preserves verbatim, and a
 * record left at `unknown` is recovered by a later replay asking again rather
 * than by a send. It is also the deployment gap, stated rather than hidden
 * behind a plausible implementation:
 *
 * > A trustworthy positive-only recovery has not been implemented or verified
 * > through the documented metadata search. Until one is, an interrupted send
 * > stays reported as unknown. A search miss can never authorize another send.
 *
 * If a tenant-bound positive lookup is implemented and verified, it belongs
 * here. A method that returns a verdict without correlation it can vouch for
 * does not belong in this package.
 */

import type {
  EmailDeliveryStatusLookup,
  EmailDeliveryStatusPort,
  EmailGatewayOutcome,
} from '@archava/act-email'

/** Which status port this is, for the audit trail. Not a secret. */
export const POSTMARK_STATUS_PORT_ID = 'postmark:status@1'

/** The reason a lookup this port cannot make answers with. */
const UNAVAILABLE = 'status_not_available'

export interface PostmarkStatusPortOptions {
  /** Which deployment this port reports on. Not a secret. */
  readonly deployment?: string
}

/**
 * The Postmark status port: read-only, and never able to answer.
 *
 * Credential-free, because a port that cannot reach the provider has nothing to
 * authenticate. The lookup it is handed is accepted and deliberately ignored,
 * so nothing about an attempt — not its tenant, not its key, not its
 * fingerprint — goes anywhere from a question that cannot be answered with it.
 */
export class PostmarkStatusPort implements EmailDeliveryStatusPort {
  readonly statusPortId: string

  constructor(options: PostmarkStatusPortOptions = {}) {
    this.statusPortId =
      options.deployment === undefined
        ? POSTMARK_STATUS_PORT_ID
        : `${POSTMARK_STATUS_PORT_ID}(${options.deployment})`
  }

  status(lookup: EmailDeliveryStatusLookup): Promise<EmailGatewayOutcome> {
    // Unused on purpose: there is no lookup to make, and a question that cannot
    // be answered is not a reason to keep what it carried.
    void lookup
    return Promise.resolve({ outcome: 'unknown', reason: UNAVAILABLE })
  }
}
