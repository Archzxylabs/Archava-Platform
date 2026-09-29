/**
 * The confirmation challenge port, over PostgreSQL.
 *
 * The promise is narrow and worth restating: **a challenge can be spent once,
 * and the caller that spent it is the one that sees the row.** The way it is kept
 * is by not reading before writing.
 *
 * `consume` is one conditional `UPDATE ... RETURNING` whose predicate carries the
 * challenge id, the tenant, the session, the action, both digests, the current
 * state and the supplied time. The decision and the spend are the same step, so
 * two concurrent presentations of one challenge produce one transition and one
 * `spent`, and the loser can only be told the row is already consumed — there is
 * nothing else it could have transitioned. `statements.ts` says why every clause
 * is in the SQL rather than in JavaScript.
 *
 * What this file adds is **what happens when the answer is not a row.** Zero rows
 * is followed by an id-scoped lookup that decides between `already_consumed`,
 * `expired`, `mismatch` and `not_found`; a client rejection, two rows for one
 * id, a row that does not validate, or a pending matching row that was somehow
 * not spent all produce `unavailable`. The port's vocabulary is explicit that
 * `unavailable` means "the store could not answer", and it must never be
 * narrowed into "no such challenge": a caller told a spent challenge never
 * existed is a caller who may ask again.
 *
 * The one asymmetry: `issue` throws where `consume` reports `unavailable`. The
 * port asks for it — `false` from `issue` means "the id is taken" and a throw
 * means "the store is unavailable", and the service turns each into a different
 * answer. Collapsing the two would make an outage look like an id collision,
 * which is the failure mode `ON CONFLICT DO NOTHING` was chosen to avoid.
 *
 * ## Failures this file refuses to get wrong
 *
 * | What could go wrong | What it would cost | What it does instead |
 * |---|---|---|
 * | `now()` instead of the supplied time | A spend depends on a clock the service cannot see | Binds the caller's instant twice; the clock is never queried |
 * | A tenant id interpolated into SQL text | One tenant spending another's challenge | Every value is a `$n` parameter; the text carries none of them |
 * | Zero rows read as "no such challenge" | A spent challenge looks unspent | Classifies before answering, and refuses when it cannot |
 * | An error answered as a verdict | A spent challenge looks unspent | Every uncertain outcome is `unavailable` |
 */

import type {
  ConfirmationChallengeConsumeResult,
  ConfirmationChallengeConsumption,
  ConfirmationChallengeInsert,
  ConfirmationChallengeRecord,
} from '@archava/act-confirmation'
import type { SqlClient, SqlRow } from '@archava/act-storage'
import { readChallengeRow, readMilliseconds, type ChallengeRowReading } from './row.js'
import {
  consumeChallengeStatement,
  issueChallengeStatement,
  lookupChallengeStatement,
} from './statements.js'

/** What a transition answered, before it has been classified. */
type TransitionAnswer =
  | { readonly status: 'rows'; readonly rows: readonly SqlRow[] }
  | { readonly status: 'unavailable'; readonly reason: string }

export class PostgresChallengeStore {
  readonly storeId = 'postgres-confirmation-challenges'

  constructor(private readonly client: SqlClient) {}

  /**
   * Write a pending challenge, or report that its id is taken.
   *
   * `false` is an answer, not an error: the id is present and was not
   * overwritten. The insert is a single `ON CONFLICT (id) DO NOTHING`, so the
   * loser of a race gets zero rows back rather than an exception, and nothing
   * that was already there is rewritten.
   *
   * Throws for everything else — an unreadable window, a client failure. The
   * service distinguishes the two, and only the conflict is `false`.
   */
  async issue(challenge: ConfirmationChallengeInsert): Promise<boolean> {
    // Checked here so a row cannot be born expired: the CHECK constraint would
    // reject it as a violation, and the store would then have no way to say
    // whether the insert happened.
    const issuedAt = readMilliseconds(challenge.issuedAt)
    const expiresAt = readMilliseconds(challenge.expiresAt)
    if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt) {
      throw new Error('postgres_challenge_store_issue_window_unreadable')
    }

    const statement = issueChallengeStatement(challenge)
    let rows: readonly SqlRow[]
    try {
      rows = await this.client.run(statement)
    } catch (error) {
      // "Nobody knows" is not "this id is taken". Reaching the caller as a throw
      // is what keeps an outage from being answered with `false`.
      throw new Error('postgres_challenge_store_issue_unavailable', { cause: error })
    }

    if (rows.length === 0) return false
    if (rows.length !== 1 || rows[0]?.id !== challenge.id) {
      throw new Error('postgres_challenge_store_issue_returning_unreadable')
    }
    return true
  }

  /**
   * Spend one matching pending challenge, or report why it could not be spent.
   *
   * Atomic by construction: the predicate that matches the row is the predicate
   * that transitions it, so a second presentation of the same challenge has no
   * pending row left to transition and can only be classified.
   */
  async consume(
    presentation: ConfirmationChallengeConsumption,
  ): Promise<ConfirmationChallengeConsumeResult> {
    // Validated before any statement runs. A fractional instant would be
    // compared against an expiry the service's arithmetic cannot produce, and a
    // spend at one is irreconcilable with the row it stamps.
    const now = readMilliseconds(presentation.now)
    if (now === null) {
      return { status: 'unavailable', reason: 'presented_time_not_milliseconds' }
    }

    const answer = await this.transition(presentation)
    if (answer.status === 'unavailable') return answer

    // The row is the evidence, and the only evidence. Claiming a spend without
    // one would be a guess, which is how a confirmation gets spent twice.
    const { rows } = answer
    if (rows.length > 1) {
      return { status: 'unavailable', reason: 'transition_returned_multiple_rows' }
    }
    if (rows.length === 0) {
      return this.classifyUnspent(presentation, now)
    }
    // Checked rather than indexed: a driver that promised a row and returned a
    // hole is not a row that can be read.
    const row = rows[0]
    if (row === undefined) {
      return { status: 'unavailable', reason: 'transitioned_row_unreadable' }
    }
    const spent = readChallengeRow(row, presentation.id)
    // The reader's `absent` is not reachable here — it is the answer to zero
    // rows, and this branch is one row. It is kept in the refusal anyway: a row
    // the reader could not vouch for is a row the store must not spend.
    if (spent.status !== 'record') {
      return { status: 'unavailable', reason: transitionRowFailure(spent) }
    }
    if (
      !presents(spent.challenge, presentation) ||
      spent.challenge.state !== 'consumed' ||
      spent.challenge.consumedAt !== now ||
      now < spent.challenge.issuedAt ||
      now >= spent.challenge.expiresAt
    ) {
      return { status: 'unavailable', reason: 'transitioned_row_not_matching_spend' }
    }
    return { status: 'spent', challenge: spent.challenge }
  }

  /**
   * The single conditional update, with its two outcomes kept apart.
   *
   * A rejected statement is not one of its rows: `SqlClient` resolves for "zero
   * rows" and rejects only when the answer is unknown, and the difference is
   * whether the store is allowed to conclude anything at all.
   */
  private async transition(
    presentation: ConfirmationChallengeConsumption,
  ): Promise<TransitionAnswer> {
    try {
      return {
        status: 'rows',
        rows: await this.client.run(consumeChallengeStatement(presentation)),
      }
    } catch {
      return { status: 'unavailable', reason: 'transition_statement_failed' }
    }
  }

  /**
   * Why a zero-row transition did not spend the challenge.
   *
   * Scoped by the challenge id alone, on purpose. If the lookup carried the
   * tenant, the session or the digests, a presentation that failed to match would
   * come back `not_found` and the store would lose the one distinction it exists
   * to make. So the row is read by id and compared here.
   *
   * The comparison happens *before* the state is consulted, which is what keeps
   * a cross-tenant replay from being handed `already_consumed`: a caller who
   * presents somebody else's challenge must learn that its presentation matched
   * nothing, not that the challenge it aimed at is spent.
   *
   * `not_found` is the answer of last resort, and the honest one — the challenge
   * never existed, so no consent was spent on this id.
   */
  private async classifyUnspent(
    presentation: ConfirmationChallengeConsumption,
    now: number,
  ): Promise<ConfirmationChallengeConsumeResult> {
    const statement = lookupChallengeStatement(presentation.id)
    let rows: readonly SqlRow[]
    try {
      rows = await this.client.run(statement)
    } catch {
      return { status: 'unavailable', reason: 'lookup_statement_failed' }
    }
    if (rows.length > 1) {
      return { status: 'unavailable', reason: 'lookup_returned_multiple_rows' }
    }
    if (rows.length === 0) {
      return { status: 'not_found' }
    }
    const row = rows[0]
    if (row === undefined) {
      return { status: 'unavailable', reason: 'lookup_row_unreadable' }
    }
    const reading = readChallengeRow(row, presentation.id)
    if (reading.status !== 'record') {
      return { status: 'unavailable', reason: lookupRowFailure(reading) }
    }
    return classify(reading.challenge, presentation, now)
  }
}

/**
 * Why a row that came back could not be spent, as one reason string.
 *
 * A refused reading is either `malformed` — there was a row and it does not check
 * out — or `absent`, which is not a possible answer to one row and is reported as
 * the refusal it is rather than as "nothing there".
 */
function transitionRowFailure(reading: ChallengeRowReading): string {
  return reading.status === 'malformed'
    ? `transitioned_row_${reading.reason}`
    : 'transitioned_row_absent'
}

/** The same reading, asked by the classifier. */
function lookupRowFailure(reading: ChallengeRowReading): string {
  return reading.status === 'malformed' ? `lookup_row_${reading.reason}` : 'lookup_row_absent'
}

/**
 * What a row the predicate declined says.
 *
 * Every answer here is reached through `matches` first, because the ordering is
 * a security property rather than a tidiness one.
 */
function classify(
  challenge: ConfirmationChallengeRecord,
  presentation: ConfirmationChallengeConsumption,
  now: number,
): ConfirmationChallengeConsumeResult {
  if (!presents(challenge, presentation)) {
    return { status: 'mismatch' }
  }
  if (challenge.state === 'consumed') {
    return { status: 'already_consumed', challenge }
  }
  // A matching row the predicate declined. A closed expiry has its own verdict;
  // a row presented before issuance has none in the port vocabulary and falls
  // through to unavailable without consuming the challenge.
  if (challenge.expiresAt <= now) {
    return { status: 'expired', challenge }
  }
  // An early row, or a pending, matching in-window row that was not spent.
  // Neither may be reported as a spend or as a nonexistent challenge.
  return { status: 'unavailable', reason: 'unexplained_zero_row_transition' }
}

/** Every identity the presentation is allowed to answer a challenge with. */
function presents(
  challenge: ConfirmationChallengeRecord,
  presentation: ConfirmationChallengeConsumption,
): boolean {
  return (
    challenge.id === presentation.id &&
    challenge.tenantId === presentation.tenantId &&
    challenge.sessionId === presentation.sessionId &&
    challenge.actionId === presentation.actionId &&
    challenge.tokenDigest === presentation.tokenDigest &&
    challenge.bindingDigest === presentation.bindingDigest
  )
}
