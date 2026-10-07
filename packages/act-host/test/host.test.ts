/**
 * The trusted server host, exercised as the thing between a browser and a write.
 *
 * Every case here is one question a deployment will actually be asked. The
 * assertions are always the same shape: either the host refused before anything
 * happened, or it handed `runTurn` exactly one action — the one the receipt was
 * for, with exactly the inputs the challenge was bound to, under the timestamp
 * the attempt was opened under and not one derived after a timeout.
 *
 * The store, the clock and the executor are offline doubles from `fakes.ts`, so
 * a failure in this file is a decision this package made and nothing else. What
 * is *not* faked is the ladder: the real `ActionPolicy`, the real
 * `validateActionInputs`, the real entity resolver contract, the real
 * `ConfirmationService` and the real `runTurn`. Those are the gates the host
 * exists to steer a request through without letting it skip them, and a gate
 * mocked out cannot testify to that.
 */

import { describe, expect, it } from 'vitest'
import type { BrainProvider, BrainTurn } from '@archava/adapters'
import type { ActionExecutionRequest } from '@archava/assistant'

import {
  ACT_HOST_REFUSAL_CODES,
  ActHost,
  ActHostRefusal,
  InMemoryActHostAttemptLedger,
  attemptIdentityKey,
  type ActHostAttemptIdentity,
  type ActHostAttemptLedger,
  type ActHostAttemptRecord,
  type ActHostOptions,
  type ActHostRefusalCode,
  type ActHostReview,
} from '../src/index.js'
import {
  ACTION,
  ADMIN_ACTION,
  CAPABILITY,
  CHANGED_INPUTS,
  CONFIRMING,
  ENTERPRISE,
  INPUTS,
  OTHER_ACTION,
  OWNER,
  READ_ACTION,
  ROLE,
  SECRET,
  SECRET_BEARING_INPUTS,
  SESSION,
  TENANT,
  confirmations,
  graph,
  policy,
  recordingExecutor,
  SILENT_KNOWLEDGE,
  uncertainExecutor,
} from './fakes.js'

/** What a browser actually sends: one action candidate, and nothing else. */
function envelopeFor(actionId: string, inputs: Readonly<Record<string, unknown>>): unknown {
  return { utterance: 'book me the room nearest the beach', action: { actionId, inputs } }
}

/** The same envelope, now carrying a presentation the host may spend. */
function presenting(
  challengeId: string,
  token: string,
  actionId = ACTION,
  inputs: Readonly<Record<string, unknown>> = INPUTS,
): unknown {
  return {
    utterance: 'book me the room nearest the beach',
    action: { actionId, inputs },
    confirmation: { challengeId, token },
  }
}

/**
 * A brain that asks for the given actions, and remembers the turns it saw.
 *
 * Pass the requests explicitly rather than defaulting them: a test that is about
 * the gate should be asked for the action under test, and a test that is about
 * binding needs a second candidate whose own gate would have let it run, or the
 * test proves nothing that binding did.
 */
function askingBrain(
  ...requests: readonly (readonly [actionId: string, inputs: Readonly<Record<string, unknown>>])[]
): BrainProvider & { readonly turns: readonly BrainTurn[] } {
  const turns: BrainTurn[] = []
  return {
    providerId: 'act-host-test-brain',
    model: 'act-host-test-brain@1',
    health: { ready: true, reason: null },
    reply(turn: BrainTurn) {
      turns.push(turn)
      return Promise.resolve({
        text: 'On it.',
        requestedActions: requests.map(([actionId, inputs]) => ({ actionId, inputs })),
        citations: [],
        deferToStructuredTruth: false,
      })
    },
    get turns() {
      return turns
    },
  }
}

/** The ledger, with its writes kept, so a test can read what a record holds. */
function recordingLedger(): ActHostAttemptLedger & {
  readonly saves: readonly ActHostAttemptRecord[]
} {
  const inner = new InMemoryActHostAttemptLedger()
  const saves: ActHostAttemptRecord[] = []
  return {
    ledgerId: inner.ledgerId,
    save(record: ActHostAttemptRecord) {
      saves.push({ ...record })
      return inner.save(record)
    },
    find: (identity: ActHostAttemptIdentity) => inner.find(identity),
    findByChallenge: (challengeId: string) => inner.findByChallenge(challengeId),
    get saves() {
      return saves
    },
  }
}

interface HostFixture {
  readonly host: ActHost
  readonly executor: ReturnType<typeof recordingExecutor>
  readonly confirmation: ReturnType<typeof confirmations>
  readonly ledger: ReturnType<typeof recordingLedger>
}

/**
 * A host wired the way a deployment wires it: everything server-owned passed in
 * from the outside, and nothing about it taken from the request.
 *
 * `clock` is deliberately the *same* clock the confirmation service reads, so a
 * test can move time forward and have both the challenge's window and the host's
 * own reading agree about what happened.
 */
function fixture(overrides: Partial<ActHostOptions> = {}): HostFixture {
  const confirmation = confirmations()
  const executor = recordingExecutor()
  const ledger = recordingLedger()
  const host = new ActHost({
    tenantId: TENANT,
    sessionId: SESSION,
    policy: policy(),
    capability: CAPABILITY,
    role: ROLE,
    brain: askingBrain([ACTION, INPUTS]),
    knowledge: SILENT_KNOWLEDGE,
    resolver: CONFIRMING,
    confirmations: confirmation.service,
    executor,
    attempts: ledger,
    clock: confirmation.clock.now,
    ...overrides,
  })
  return { host, executor, confirmation, ledger }
}

/** The refusal a rejected call threw, so a test can assert on its code. */
async function refusalOf(run: () => Promise<unknown>): Promise<ActHostRefusal> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ActHostRefusal) return error
    throw error
  }
  throw new Error('expected an ActHostRefusal and the call resolved instead')
}

/** The issued half of a review, or a failure that names what it expected. */
function issued(review: ActHostReview): {
  readonly challengeId: string
  readonly token: string
  readonly occurredAt: string
} {
  if (review.status !== 'challenge_issued') {
    throw new Error(`expected a challenge, got ${JSON.stringify(review)}`)
  }
  return {
    challengeId: review.challenge.challengeId,
    token: review.challenge.token,
    occurredAt: review.occurredAt,
  }
}

/** The idempotency keys the executor was handed, in order. */
function keysOf(requests: readonly ActionExecutionRequest[]): readonly string[] {
  return requests.map((request) => request.idempotencyKey)
}

describe('ActHost.review', () => {
  it('issues one challenge bound to server-owned facts and the exact inputs, and executes nothing', async () => {
    const { host, executor, confirmation } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )

    // Exactly one challenge, naming the tenant, the session and the action the
    // *host* owns — not anything the envelope could have supplied.
    expect(confirmation.store.issues).toBe(1)
    const insert = confirmation.store.inserts[0]
    if (insert === undefined) throw new Error('expected one insert')
    expect(insert.tenantId).toBe(TENANT)
    expect(insert.sessionId).toBe(SESSION)
    expect(insert.actionId).toBe(ACTION)
    // The store never sees the inputs themselves — only the binding digest,
    // which is the only input the presentation is later compared against.
    expect(insert.bindingDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(insert.tokenDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(insert.expiresAt).toBeGreaterThan(insert.issuedAt)

    // Review is the question, not the deed. Nothing has run, because there is
    // nothing yet that a running of it could cite.
    expect(executor.calls).toEqual([])
    expect(executor.requests).toEqual([])
    expect(challenge.challengeId).toBe(insert.id)
  })

  it('binds the challenge to our tenant and session even when the envelope names another', async () => {
    const { host, confirmation } = fixture()

    const challenge = issued(
      await host.review({
        envelope: {
          ...(envelopeFor(ACTION, INPUTS) as Record<string, unknown>),
          tenantId: 'someone-elses-hotel',
          sessionId: 'someone-elses-session',
          occurredAt: '1999-01-01T00:00:00.000Z',
        },
        graph: graph(ACTION),
      }),
    )

    const insert = confirmation.store.inserts[0]
    if (insert === undefined) throw new Error('expected one insert')
    expect(insert.tenantId).toBe(TENANT)
    expect(insert.sessionId).toBe(SESSION)
    // The one field a browser has every incentive to control is the one it is
    // never asked for.
    expect(challenge.occurredAt).not.toBe('1999-01-01T00:00:00.000Z')
  })

  it('re-mints a different challenge for the same action on different inputs', async () => {
    // The store holds no inputs, so "the exact inputs" is proven by the digest
    // rather than by a stored copy: a different slot is a different agreement,
    // and a digest that failed to move with the inputs would let a receipt for
    // one booking spend a challenge minted for another.
    const { host, confirmation, ledger } = fixture()

    const first = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const second = issued(
      await host.review({ envelope: envelopeFor(ACTION, CHANGED_INPUTS), graph: graph(ACTION) }),
    )

    expect(confirmation.store.issues).toBe(2)
    expect(second.challengeId).not.toBe(first.challengeId)
    expect(confirmation.store.inserts[0]?.bindingDigest).not.toBe(
      confirmation.store.inserts[1]?.bindingDigest,
    )
    // Same action, same session, different payload — so this is a *different*
    // attempt, and a second record was opened for it.
    expect(ledger.saves.map((record) => record.challengeId)).toEqual([
      first.challengeId,
      second.challengeId,
    ])
    expect(new Set(ledger.saves.map((record) => record.inputDigest)).size).toBe(2)
  })

  it('refuses a page that does not offer the action, before it will ask about inputs', async () => {
    const { host, confirmation } = fixture()

    // The gate first: an action the page does not offer is not a validation
    // problem, and refusing it as though it were would answer a question the
    // visitor never asked.
    const refusal = await refusalOf(() =>
      host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph() }),
    )
    expect(refusal.code).toBe('visitor_action_not_permitted')
    expect(confirmation.store.issues).toBe(0)
  })

  it('refuses to mint a confirmation for an action the gate would allow outright', async () => {
    const { host, confirmation } = fixture()

    const refusal = await refusalOf(() =>
      host.review({ envelope: envelopeFor(READ_ACTION, {}), graph: graph(READ_ACTION) }),
    )
    expect(refusal.code).toBe('visitor_confirmation_not_required')
    expect(confirmation.store.issues).toBe(0)
  })

  it('refuses to mint a confirmation where the gate wants a person, not a visitor', async () => {
    const { host, confirmation } = fixture({ capability: ENTERPRISE, role: OWNER })

    const refusal = await refusalOf(() =>
      host.review({
        envelope: envelopeFor(ADMIN_ACTION, { setting: 'currency' }),
        graph: graph(ADMIN_ACTION),
      }),
    )
    expect(refusal.code).toBe('visitor_human_approval_required')
    expect(confirmation.store.issues).toBe(0)
  })

  it('refuses to hand out a token the store would not keep', async () => {
    const { host, executor, confirmation } = fixture()
    confirmation.store.failNextIssue = 'outage'

    const refusal = await refusalOf(() =>
      host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )

    // An outage is a deployment fact, not a visitor fact: the refusal names the
    // service's own reason and nothing else, and no token exists for a second
    // call to present.
    expect(refusal.code).toBe('confirmation_refused')
    expect(refusal.rejection).toBe('store_unavailable')
    expect(executor.calls).toEqual([])

    // A store that answers "that id is taken" is a no too, and equally
    // tokenless: a challenge a store would not record is not a challenge, and a
    // caller holding a token nothing could spend is a caller misled.
    confirmation.store.failNextIssue = 'conflict'
    const second = await refusalOf(() =>
      host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    expect(second.code).toBe('confirmation_refused')
    expect(second.rejection).toBe('store_conflict')
    expect(executor.calls).toEqual([])
  })

  it('refuses an action the registry does not know, before it will ask about its inputs', async () => {
    // The gate is asked first: an id the registry has never heard of is not a
    // confirmation problem, a contract problem or an execution problem — it is
    // not an action, and the visitor never gets a challenge for one.
    const { host, confirmation } = fixture()

    const refusal = await refusalOf(() =>
      host.review({
        envelope: envelopeFor('booking.create.mystery', INPUTS),
        graph: graph('booking.create.mystery'),
      }),
    )
    expect(refusal.code).toBe('visitor_action_not_permitted')
    expect(confirmation.store.issues).toBe(0)
  })

  it('refuses inputs that omit a required entity the contract bears on', async () => {
    // A slot with no customer is not "an input with a gap" — the contract names
    // the customer, so no challenge is minted for an agreement that is missing
    // half of what it is about.
    const { host, confirmation } = fixture()

    const refusal = await refusalOf(() =>
      host.review({
        envelope: envelopeFor(ACTION, { slotId: 'slot_1' }),
        graph: graph(ACTION),
      }),
    )
    expect(refusal.code).toBe('visitor_inputs_rejected')
    expect(refusal.fields).toEqual([
      { field: '*', reason: 'The submitted inputs did not pass validation.' },
    ])
    expect(confirmation.store.issues).toBe(0)
  })

  it('refuses an unknown input without echoing its name or value', async () => {
    const { host, confirmation } = fixture()

    const refusal = await refusalOf(() =>
      host.review({
        envelope: envelopeFor(ACTION, { ...INPUTS, cardNumber: SECRET }),
        graph: graph(ACTION),
      }),
    )

    expect(refusal.code).toBe('visitor_inputs_rejected')
    expect(refusal.fields?.map((field) => field.field)).toEqual(['*'])
    for (const field of refusal.fields ?? []) {
      expect(field.reason).not.toContain(SECRET)
    }
    expect(JSON.stringify(refusal)).not.toContain(SECRET)
    expect(JSON.stringify(refusal)).not.toContain('cardNumber')
    expect(confirmation.store.issues).toBe(0)
  })

  it('refuses an input that names an entity no authoritative resolver answers for', async () => {
    const { host, confirmation } = fixture()

    const refusal = await refusalOf(() =>
      host.review({
        envelope: envelopeFor(ACTION, { slotId: 'slot_1', customer: { customerRef: 'cust_nope' } }),
        graph: graph(ACTION),
      }),
    )

    expect(refusal.code).toBe('visitor_inputs_rejected')
    expect(JSON.stringify(refusal)).not.toContain('cust_nope')
    expect(confirmation.store.issues).toBe(0)
  })

  it('does not issue an Act challenge for an Assist tenant', async () => {
    const { host, confirmation } = fixture({ capability: 'assist' })
    const refusal = await refusalOf(() =>
      host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    expect(refusal.code).toBe('visitor_action_not_permitted')
    expect(confirmation.store.issues).toBe(0)
  })

  it('fails closed when an entity-bearing Act action has no resolver', async () => {
    const { host, confirmation } = fixture({ resolver: undefined })
    const refusal = await refusalOf(() =>
      host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    expect(refusal.code).toBe('visitor_inputs_rejected')
    expect(confirmation.store.issues).toBe(0)
  })
})

describe('ActHost.present', () => {
  it('runs exactly the confirmed action with exactly the confirmed inputs', async () => {
    const { host, executor } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const outcome = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token),
      graph: graph(ACTION),
    })

    // One execution, of the bound action, with the bound payload, under the
    // tenant and session the host was built with.
    expect(executor.calls).toEqual([{ action: ACTION, inputs: INPUTS }])
    const request = executor.requests[0]
    if (request === undefined) throw new Error('expected one execution')
    expect(request.tenantId).toBe(TENANT)
    expect(request.sessionId).toBe(SESSION)
    // The executor receives the bound payload and a key; the public result
    // exposes neither the payload, the key, nor the internal turn timestamp.
    expect(request.idempotencyKey).toBeTruthy()
    expect(request.inputs).toEqual(INPUTS)
    expect(outcome).toEqual({
      actionId: ACTION,
      execution: 'succeeded',
      text: 'Permintaan Anda berhasil diproses.',
    })
    expect(JSON.stringify(outcome)).not.toContain(request.idempotencyKey)
  })

  it('refuses a presentation that carries no confirmation at all', async () => {
    const { host, executor } = fixture()

    const refusal = await refusalOf(() =>
      host.present({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    expect(refusal.code).toBe('visitor_confirmation_required')
    expect(executor.calls).toEqual([])
  })

  it('refuses a challenge this host has no record of', async () => {
    const { host, executor } = fixture()

    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting('challenge_nobody_minted', 'a-token'),
        graph: graph(ACTION),
      }),
    )
    expect(refusal.code).toBe('attempt_record_missing')
    expect(executor.calls).toEqual([])
  })

  it('refuses a presentation naming a different action than the challenge was issued for', async () => {
    const { host, executor } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting(challenge.challengeId, challenge.token, OTHER_ACTION, INPUTS),
        graph: graph(ACTION, OTHER_ACTION),
      }),
    )

    expect(refusal.code).toBe('visitor_challenge_mismatch')
    expect(executor.calls).toEqual([])
  })

  it('refuses a valid challenge from another server-owned session before spending it', async () => {
    const first = fixture()
    const second = fixture({
      sessionId: 'another-session',
      confirmations: first.confirmation.service,
      attempts: first.ledger,
    })
    const challenge = issued(
      await first.host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )

    const refusal = await refusalOf(() =>
      second.host.present({
        envelope: presenting(challenge.challengeId, challenge.token),
        graph: graph(ACTION),
      }),
    )

    expect(refusal.code).toBe('visitor_challenge_mismatch')
    expect(first.confirmation.store.stateOf(challenge.challengeId)?.state).toBe('pending')
    expect(first.executor.calls).toEqual([])
    expect(second.executor.calls).toEqual([])
  })

  it('binds and executes the parsed inputs, including nested object normalization', async () => {
    const { host, executor } = fixture()
    const raw = {
      slotId: 'slot_1',
      customer: { customerRef: 'cust_9', notes: 'quiet room', ignored: 'not in contract' },
    }
    const parsed = {
      slotId: 'slot_1',
      customer: { customerRef: 'cust_9', notes: 'quiet room' },
    }
    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, raw), graph: graph(ACTION) }),
    )
    const outcome = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token, ACTION, raw),
      graph: graph(ACTION),
    })

    expect(outcome.execution).toBe('succeeded')
    expect(executor.calls).toEqual([{ action: ACTION, inputs: parsed }])
  })

  it('refuses the same action id presented with changed inputs', async () => {
    const { host, executor } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting(challenge.challengeId, challenge.token, ACTION, CHANGED_INPUTS),
        graph: graph(ACTION),
      }),
    )

    // A different agreement, not a typo of one. The binding covers the inputs,
    // so a second candidate that shares the action id cannot ride in on the
    // receipt the first was issued for.
    expect(refusal.code).toBe('visitor_challenge_mismatch')
    expect(executor.calls).toEqual([])
  })

  it('refuses a second presentation of a challenge already spent', async () => {
    const { host, executor } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    await host.present({
      envelope: presenting(challenge.challengeId, challenge.token),
      graph: graph(ACTION),
    })
    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting(challenge.challengeId, challenge.token),
        graph: graph(ACTION),
      }),
    )

    expect(refusal.code).toBe('visitor_challenge_already_spent')
    // The first run stands. A replayed receipt buys nothing.
    expect(executor.calls).toHaveLength(1)
  })

  it('refuses a challenge past its expiry rather than replaying a late booking', async () => {
    const { host, executor, confirmation } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    // The visitor took longer than the challenge is good for. The clock moved;
    // the attempt it belongs to did not.
    confirmation.clock.advance(600_000)
    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting(challenge.challengeId, challenge.token),
        graph: graph(ACTION),
      }),
    )

    expect(refusal.code).toBe('visitor_challenge_expired')
    expect(executor.calls).toEqual([])
  })

  it('refuses rather than executes when no executor is wired', async () => {
    const { host, confirmation } = fixture({ executor: undefined })

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting(challenge.challengeId, challenge.token),
        graph: graph(ACTION),
      }),
    )

    // No effect may be claimed, so none is attempted and none is reported.
    expect(refusal.code).toBe('executor_unavailable')
    expect(confirmation.store.stateOf(challenge.challengeId)?.state).toBe('pending')
  })

  it('refuses rather than executes when the store cannot spend the challenge', async () => {
    const { host, executor, confirmation } = fixture()

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    // The store the challenge lives in stops answering, after it was minted. A
    // presentation the host cannot have spent is a presentation it must not
    // execute on.
    confirmation.store.failNextConsume = true
    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting(challenge.challengeId, challenge.token),
        graph: graph(ACTION),
      }),
    )

    // The refusal carries the service's reason and neither the token nor the
    // key, and the store records no spend — so the visitor still holds the only
    // receipt there is, and a retry with a store that answers can succeed.
    expect(refusal.code).toBe('confirmation_refused')
    expect(refusal.rejection).toBe('store_unavailable')
    expect(confirmation.store.stateOf(challenge.challengeId)?.state).toBe('pending')
    expect(executor.calls).toEqual([])
  })

  it('reports a provider that said nothing certain as a failure, and writes once', async () => {
    // A booking service that timed out has neither failed the booking nor made
    // it. The executor's contract has no third status to say so, so it reports
    // `failed` with a machine-readable code — and the host reports that through
    // rather than deciding what the silence meant.
    const uncertain = uncertainExecutor()
    const { host } = fixture({ executor: uncertain })

    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const outcome = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token),
      graph: graph(ACTION),
    })

    // The provider was asked exactly once. A second booking on an unknown first
    // one is the blind write the contract forbids, and an outcome nothing is
    // sure of is not the place to look for a second chance.
    expect(uncertain.calls).toHaveLength(1)
    expect(outcome.execution).toBe('failed')
    expect(outcome.errorCode).toBe('provider_outcome_unknown')
    expect(uncertain.calls[0]?.idempotencyKey).toBeTruthy()
  })

  it('replaces an optimistic model success claim when provider outcome is unknown', async () => {
    const uncertain = uncertainExecutor()
    const brain: BrainProvider = {
      providerId: 'optimistic-test-brain',
      model: 'optimistic-test-brain@1',
      health: { ready: true, reason: null },
      reply: () =>
        Promise.resolve({
          text: 'Your booking is confirmed.',
          requestedActions: [{ actionId: ACTION, inputs: INPUTS }],
          citations: [{ sourceId: 's1', sourceTitle: 'Booking confirmation' }],
          components: [{ kind: 'cta', props: { label: 'Booking confirmed', actionId: ACTION } }],
          deferToStructuredTruth: false,
        }),
    }
    const { host } = fixture({ brain, executor: uncertain })
    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const outcome = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token),
      graph: graph(ACTION),
    })

    expect(outcome.execution).toBe('failed')
    expect(outcome.text).not.toContain('confirmed')
    expect(outcome.text).toContain('belum bisa memastikan')
    expect(Object.keys(outcome).sort()).toEqual(['actionId', 'errorCode', 'execution', 'text'])
    expect(uncertain.calls).toHaveLength(1)
  })

  it('never reads a confirmed list, a capability or a role out of the envelope', async () => {
    const { host, executor, confirmation } = fixture()

    /** A presentation carrying the three claims a browser would most like to make. */
    function claiming(
      challengeId: string,
      token: string,
      confirmedActionIds: readonly string[],
    ): unknown {
      return {
        ...(presenting(challengeId, token) as Record<string, unknown>),
        confirmedActionIds,
        capability: 'enterprise',
        role: 'owner',
        permissionToken: 'signed-token',
      }
    }

    const first = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    // An empty list, as though the browser could satisfy the gate itself.
    const firstOutcome = await host.present({
      envelope: claiming(first.challengeId, first.token, []),
      graph: graph(ACTION),
    })

    confirmation.clock.advance(90_000)
    const second = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    // A second candidate riding along on the claim, now that the receipt is out.
    const secondOutcome = await host.present({
      envelope: claiming(second.challengeId, second.token, [ACTION, ADMIN_ACTION]),
      graph: graph(ACTION),
    })

    // The list, the capability and the role arrive from the host's own
    // constructor, and neither turn that ran was changed by either claim. Both
    // are the same attempt, so both carry the timestamp the first was opened
    // under — a re-ask is a retry, not a second booking.
    expect(executor.calls).toEqual([
      { action: ACTION, inputs: INPUTS },
      { action: ACTION, inputs: INPUTS },
    ])
    expect(new Set(keysOf(executor.requests)).size).toBe(1)
    expect(firstOutcome.execution).toBe('succeeded')
    expect(secondOutcome.execution).toBe('succeeded')
  })
})

describe('ActHost.occurredAt', () => {
  it('keeps tenant, session and action boundaries unambiguous in the ledger key', () => {
    const first = attemptIdentityKey({
      tenantId: 'tenant one',
      sessionId: 'session',
      actionId: ACTION,
      inputDigest: 'digest',
    })
    const second = attemptIdentityKey({
      tenantId: 'tenant',
      sessionId: 'one session',
      actionId: ACTION,
      inputDigest: 'digest',
    })
    expect(first).not.toBe(second)
  })

  it('holds one timestamp for a retry of the same attempt, so a replay mints one key', async () => {
    const { host, executor, confirmation, ledger } = fixture()

    const first = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )

    // The timeout, the reload, the re-submitted form: each of them asks again,
    // and the clock has moved on since the last time it did.
    confirmation.clock.advance(90_000)
    const second = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )

    // A fresh challenge — the old one is superseded — under the *same* moment in
    // the session. This is the whole guarantee: a timeout after a booking must
    // not become a second booking.
    expect(second.challengeId).not.toBe(first.challengeId)
    expect(second.occurredAt).toBe(first.occurredAt)
    expect(ledger.saves).toHaveLength(2)
    for (const record of ledger.saves) {
      expect(record.occurredAt).toBe(first.occurredAt)
    }

    const outcome = await host.present({
      envelope: presenting(second.challengeId, second.token),
      graph: graph(ACTION),
    })
    // The public result is narrow; the ledger proves timestamp stability.
    expect(outcome.execution).toBe('succeeded')
    expect(ledger.saves[1]?.occurredAt).toBe(first.occurredAt)
    expect(executor.requests).toHaveLength(1)
  })

  it('derives the same idempotency key for the replay as it did for the first attempt', async () => {
    const { host, executor, confirmation, ledger } = fixture()

    const first = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    await host.present({
      envelope: presenting(first.challengeId, first.token),
      graph: graph(ACTION),
    })
    confirmation.clock.advance(120_000)

    const second = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    await host.present({
      envelope: presenting(second.challengeId, second.token),
      graph: graph(ACTION),
    })

    expect(executor.requests).toHaveLength(2)
    // One attempt, one key: the executor's de-duplication has something to
    // recognise, which is what stops a retry becoming a second booking.
    expect(new Set(keysOf(executor.requests)).size).toBe(1)
    for (const record of ledger.saves) {
      expect(record.occurredAt).toBe(first.occurredAt)
    }
  })

  it('opens a new timestamp for a genuinely different attempt', async () => {
    const { host, confirmation, ledger } = fixture()

    const first = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    confirmation.clock.advance(60_000)
    const second = issued(
      await host.review({ envelope: envelopeFor(ACTION, CHANGED_INPUTS), graph: graph(ACTION) }),
    )

    // Changed inputs are a different agreement, and a different agreement is a
    // different moment. Stability is about retries, not about collapsing every
    // attempt the session ever opened into one.
    expect(second.occurredAt).not.toBe(first.occurredAt)
    expect(new Set(ledger.saves.map((record) => record.occurredAt)).size).toBe(2)
  })
})

describe('ActHost.bound execution', () => {
  it('ignores a changed model payload under the same action id', async () => {
    const { host, executor } = fixture({ brain: askingBrain([ACTION, CHANGED_INPUTS]) })
    const challenge = issued(
      await host.review({ envelope: envelopeFor(ACTION, INPUTS), graph: graph(ACTION) }),
    )
    const outcome = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token),
      graph: graph(ACTION),
    })
    expect(outcome.execution).toBe('succeeded')
    expect(executor.calls).toEqual([{ action: ACTION, inputs: INPUTS }])
  })

  it('lets the brain ask for a second action and runs only the confirmed one', async () => {
    const { host, executor } = fixture({
      brain: askingBrain([ACTION, INPUTS], [READ_ACTION, {}]),
    })

    const challenge = issued(
      await host.review({
        envelope: envelopeFor(ACTION, INPUTS),
        graph: graph(ACTION, READ_ACTION),
      }),
    )
    const outcome = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token),
      graph: graph(ACTION, READ_ACTION),
    })

    // The model asked for two and one of them needed no consent at all, so
    // nothing but binding stopped it. The receipt is the confirmation, and it
    // names one action.
    expect(executor.calls).toEqual([{ action: ACTION, inputs: INPUTS }])
    expect(outcome).toEqual({
      actionId: ACTION,
      execution: 'succeeded',
      text: 'Permintaan Anda berhasil diproses.',
    })
  })
})

describe('ActHost.browsing', () => {
  it('refuses an envelope that is not one of the four known shapes', async () => {
    const { host, confirmation } = fixture()

    const refusal = await refusalOf(() =>
      host.review({ envelope: { utterance: 'what rooms do you have?' }, graph: graph(ACTION) }),
    )
    // A page with no action candidate is a question, not a request. The host has
    // no index for a question, so it says nothing and issues nothing.
    expect(refusal.code).toBe('visitor_envelope_invalid')
    expect(confirmation.store.issues).toBe(0)
  })

  it('offers the actions the page really offers', async () => {
    const { host } = fixture()

    const offered = await host.availableActions(graph(ACTION, READ_ACTION))

    expect(offered).toContain(ACTION)
    expect(offered).toContain(READ_ACTION)
    expect(offered).not.toContain(ADMIN_ACTION)
  })
})

describe('ActHost.refusals', () => {
  it('reports its reasons from a closed list, so a refusal is never a surprise', () => {
    // Every code the module documents is a distinct string, and a caller can
    // switch on the type rather than on prose.
    expect(new Set<string>(ACT_HOST_REFUSAL_CODES).size).toBe(ACT_HOST_REFUSAL_CODES.length)
    expect(ACT_HOST_REFUSAL_CODES).toContain<ActHostRefusalCode>('visitor_confirmation_required')
    expect(ACT_HOST_REFUSAL_CODES).toContain<ActHostRefusalCode>('attempt_record_missing')
  })

  it('carries no token in the refusal it throws', async () => {
    const { host } = fixture()

    const refusal = await refusalOf(() =>
      host.present({
        envelope: presenting('challenge_nobody_minted', SECRET),
        graph: graph(ACTION),
      }),
    )

    expect(refusal.name).toBe('ActHostRefusal')
    expect(refusal.code).toBe('attempt_record_missing')
    // A refusal is a sentence an operator reads and a page reacts to. Neither of
    // those needs a token, and the token is not there.
    expect(refusal.message).not.toContain(SECRET)
  })

  it('keeps a raw form value out of every attempt record it writes', async () => {
    const { host, ledger, executor } = fixture()

    const challenge = issued(
      await host.review({
        envelope: envelopeFor(ACTION, SECRET_BEARING_INPUTS),
        graph: graph(ACTION),
      }),
    )
    const presentation = await host.present({
      envelope: presenting(challenge.challengeId, challenge.token, ACTION, SECRET_BEARING_INPUTS),
      graph: graph(ACTION),
    })

    expect(ledger.saves).toHaveLength(1)
    const record = ledger.saves[0]
    if (record === undefined) throw new Error('expected one record')
    expect(JSON.stringify(record)).not.toContain(SECRET)
    expect(record.inputDigest).not.toBe('')
    expect(Object.keys(record).sort()).toEqual([
      'actionId',
      'challengeId',
      'expiresAt',
      'inputDigest',
      'occurredAt',
      'sessionId',
      'tenantId',
    ])
    const publicJson = JSON.stringify(presentation)
    expect(publicJson).not.toContain(SECRET)
    expect(publicJson).not.toContain(challenge.token)
    expect(publicJson).not.toContain(executor.requests[0]?.idempotencyKey ?? 'missing-key')
    expect(Object.keys(presentation).sort()).toEqual(['actionId', 'execution', 'text'])
  })
})
