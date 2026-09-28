/**
 * The confirmation store, as a port.
 *
 * Everything this package guarantees about a confirmation being spent *at most
 * once* is guaranteed here, and the reason it can be a port is that the guarantee
 * is not this package's to keep: the service asks exactly once, and the store is
 * what answers exactly once. A store that answers twice under concurrent
 * presentation would break the contract, and so the port is specified as an
 * operation the store must perform atomically rather than as a callback the
 * service interprets.
 *
 * The two operations are the two places a confirmation's state changes, and they
 * are the only two:
 *
 * - `issue` writes a pending challenge that has not been presented to anybody.
 * - `consume` transitions a matching pending challenge to spent **and only if**
 *   it was still pending, returning what it found.
 *
 * Note what the service never does: it never reads a challenge and then writes it
 * back. A read-modify-write is exactly the shape two concurrent presentations can
 * both complete, which is how a confirmation gets spent twice. `consume` exists so
 * the transition and the check are one operation in whatever store backs this.
 *
 * Note also what the store is never handed: the raw token. It receives a digest of
 * it. A store row is a durable artefact, a backup is a durable artefact, and
 * neither is entitled to the thing that, presented once, spends a confirmation.
 */

/**
 * What has happened to a challenge.
 *
 * `consumed` is terminal — it is the state that makes a second presentation a
 * replay. The others are terminal too, and an implementation that wants to keep
 * an audit trail only ever adds rows.
 */
export type ConfirmationChallengeState = 'pending' | 'consumed' | 'expired' | 'revoked'

/**
 * What the store holds about a challenge.
 *
 * `tokenDigest` and `bindingDigest` are the only credentials-shaped things here
 * and both are already one-way. `consumedAt` is optional because a challenge that
 * has not been consumed has no such time, and the service refuses to mint a
 * receipt from a record that claims a spend without one — see `confirmation.ts`.
 */
export interface ConfirmationChallengeRecord {
  readonly id: string
  readonly tenantId: string
  readonly sessionId: string
  readonly actionId: string
  readonly tokenDigest: string
  readonly bindingDigest: string
  readonly state: ConfirmationChallengeState
  readonly issuedAt: number
  readonly expiresAt: number
  /** Set exactly when the state became `consumed`. */
  readonly consumedAt?: number
}

/** What a pending challenge is written as. */
export interface ConfirmationChallengeInsert {
  readonly id: string
  readonly tenantId: string
  readonly sessionId: string
  readonly actionId: string
  readonly tokenDigest: string
  readonly bindingDigest: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/**
 * What a presentation looks like to the store.
 *
 * The store is handed everything it needs to decide whether this challenge and
 * this token and this binding still match, which is what makes the decision — not
 * the service's re-check of it — the authoritative one.
 */
export interface ConfirmationChallengeConsumption {
  readonly id: string
  readonly tenantId: string
  readonly sessionId: string
  readonly actionId: string
  readonly tokenDigest: string
  readonly bindingDigest: string
  /** The time the presentation arrived, so the store can apply the same window. */
  readonly now: number
}

/**
 * What a store answers about a presentation.
 *
 * `mismatch` is deliberately distinct from `not_found`: one says the challenge
 * exists and none of what was presented for it does, the other says the challenge
 * does not exist. The service maps both to the same refusal, because a caller
 * learning which one it got is a caller learning which challenge ids are real.
 */
export type ConfirmationChallengeConsumeResult =
  | { readonly status: 'spent'; readonly challenge: ConfirmationChallengeRecord }
  | { readonly status: 'already_consumed'; readonly challenge: ConfirmationChallengeRecord }
  | { readonly status: 'expired'; readonly challenge: ConfirmationChallengeRecord }
  | { readonly status: 'mismatch' }
  | { readonly status: 'not_found' }
  /** The store could not answer. Never treated as "no such challenge". */
  | { readonly status: 'unavailable'; readonly reason: string }

/** An id for the store in logs, so a busy deployment knows which one broke. */
export type ConfirmationChallengeStore = {
  readonly storeId: string
  /**
   * Record a pending challenge. Returns `false`, rather than throwing, when a
   * challenge with this id already exists — a caller-safe way to say no.
   */
  readonly issue: (challenge: ConfirmationChallengeInsert) => Promise<boolean> | boolean
  /**
   * Spend a pending challenge, or report why it could not be spent. This must be
   * atomic: under two concurrent presentations of one challenge, exactly one may
   * return `spent`.
   */
  readonly consume: (
    presentation: ConfirmationChallengeConsumption,
  ) => Promise<ConfirmationChallengeConsumeResult>
}
