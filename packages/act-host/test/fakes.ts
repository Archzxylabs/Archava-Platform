/**
 * Offline doubles for the act-host tests.
 *
 * Nothing here reaches a database, a provider, a network or a real guest: the
 * challenge store is a Map that enforces the one atomic transition the contract
 * requires, the clock only moves when a test moves it, and the random source is
 * deterministic. That is what makes the assertions below assertions about *this
 * package's decisions* — about what a visitor can and cannot get executed — and
 * not about someone's infrastructure.
 *
 * The store is written out here rather than imported, because
 * `@archava/act-confirmation` deliberately ships no in-memory store: the durable
 * one is another package's deliverable, and an in-memory default in this one
 * would invite a deployment to use it as though it survived a restart.
 */

import { ActionPolicy, type RoleName } from '@archava/acl'
import { parseClientConfig, type CapabilityTierName, type ClientConfig } from '@archava/config'
import { ConfirmationService } from '@archava/act-confirmation'
import type {
  ConfirmationChallengeConsumeResult,
  ConfirmationChallengeInsert,
  ConfirmationChallengeRecord,
  ConfirmationChallengeStore,
} from '@archava/act-confirmation'
import {
  foldContextEvents,
  seedContextGraph,
  type ContextEvent,
  type ContextGraph,
} from '@archava/core'
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  EntityResolver,
  KnowledgePort,
} from '@archava/assistant'

export type { EntityResolver, RoleName }

/** The tenant, session and action every nominal case here agrees on. */
export const TENANT = 'acme-hotels'
export const SESSION = 'session-1'
export const OTHER_SESSION = 'session-2'
/** `user_confirm`, L3, capability `act`, role `archava_assistant`. */
export const ACTION = 'booking.create'
/** `user_confirm`, with an entity-bearing `bookingId` of its own. */
export const OTHER_ACTION = 'booking.reschedule'
/** `confirmation: 'none'`: permitted outright, so there is nothing to confirm. */
export const READ_ACTION = 'product.read'
/** `human_approval`: an operator's decision, never a visitor's. */
export const ADMIN_ACTION = 'admin.config.update'

/** Inputs that satisfy §9 for {@link ACTION}, given the resolver below. */
export const INPUTS = { slotId: 'slot_1', customer: { customerRef: 'cust_9' } }
/** The same action, a different slot: a different agreement, not a typo of one. */
export const CHANGED_INPUTS = { slotId: 'slot_2', customer: { customerRef: 'cust_9' } }
/** A raw form value typed into a sensitive field. */
export const SECRET = '4111 1111 1111 1111'
/** The same slot, carrying a value only the form had any reason to hold. */
export const SECRET_BEARING_INPUTS = {
  slotId: 'slot_1',
  customer: { customerRef: 'cust_9', notes: SECRET },
}

export const DIGEST_KEY = new Uint8Array(32).fill(7)

/** The capability and role a booking session runs under. */
export const CAPABILITY: CapabilityTierName = 'act'
export const ROLE: RoleName = 'archava_assistant'
/** What {@link ADMIN_ACTION} needs from a session, and a role that satisfies it. */
export const ENTERPRISE: CapabilityTierName = 'enterprise'
export const OWNER: RoleName = 'owner'

/** A clock a test moves by hand, so no assertion depends on wall time. */
export function fakeClock(at = 1_700_000_000_000) {
  let now = at
  return {
    now: (): number => now,
    advance: (by: number): number => {
      now += by
      return now
    },
  }
}

/**
 * Deterministic bytes, different on every call.
 *
 * The counter is the point: a constant would make every mint's id and token
 * identical, the store would answer "that id is taken", and the service would
 * look broken for a reason that has nothing to do with anything under test.
 */
export function fakeRandom() {
  let counter = 0
  return (byteLength: number): Uint8Array => {
    counter += 1
    const bytes = new Uint8Array(byteLength)
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = (counter * 31 + index * 7 + 0x5b) & 0xff
    }
    return bytes
  }
}

/**
 * A store that records what it was asked, and answers honestly.
 *
 * It enforces the one thing the contract requires: `consume` is atomic, so a
 * challenge presented twice is spent once and the second presentation is
 * reported as already consumed. A Map with a synchronous transition is enough
 * here precisely because nothing in this process is concurrent — which is also
 * why the tests assert on *decisions* rather than on this store's own atomicity.
 */
export class AtomicChallengeStore implements ConfirmationChallengeStore {
  readonly storeId = 'act-host-test-atomic'
  readonly inserts: ConfirmationChallengeInsert[] = []
  /** One entry per presentation, recorded whether it was spent or refused. */
  readonly consumptions: { readonly id: string; readonly now: number }[] = []
  /**
   * When set, the next `issue` reports that it could not record anything.
   *
   * `outage` throws, which is what a connection loss looks like from the
   * service's side; `conflict` answers false, which is what a duplicate challenge
   * id looks like. The service maps both to a refusal, and a test about a host's
   * behaviour under a store that will not take a challenge has to be able to
   * cause one.
   */
  failNextIssue: 'outage' | 'conflict' | null = null
  /** When set, the next `consume` throws, so a challenge cannot be spent. */
  failNextConsume = false
  private readonly records = new Map<string, ConfirmationChallengeRecord>()

  issue(insert: ConfirmationChallengeInsert): boolean {
    this.inserts.push(insert)
    if (this.failNextIssue !== null) {
      const failure = this.failNextIssue
      this.failNextIssue = null
      if (failure === 'outage') throw new Error('the store is unreachable')
      return false
    }
    if (this.records.has(insert.id)) return false
    this.records.set(insert.id, {
      id: insert.id,
      tenantId: insert.tenantId,
      sessionId: insert.sessionId,
      actionId: insert.actionId,
      tokenDigest: insert.tokenDigest,
      bindingDigest: insert.bindingDigest,
      state: 'pending',
      issuedAt: insert.issuedAt,
      expiresAt: insert.expiresAt,
    })
    return true
  }

  consume(presentation: {
    id: string
    tenantId: string
    sessionId: string
    actionId: string
    tokenDigest: string
    bindingDigest: string
    now: number
  }): Promise<ConfirmationChallengeConsumeResult> {
    this.consumptions.push({ id: presentation.id, now: presentation.now })
    if (this.failNextConsume) {
      this.failNextConsume = false
      throw new Error('the store is unreachable')
    }
    const record = this.records.get(presentation.id)
    if (record === undefined) return Promise.resolve({ status: 'not_found' })
    const matched =
      record.tenantId === presentation.tenantId &&
      record.sessionId === presentation.sessionId &&
      record.actionId === presentation.actionId &&
      record.tokenDigest === presentation.tokenDigest &&
      record.bindingDigest === presentation.bindingDigest
    if (!matched) return Promise.resolve({ status: 'mismatch' })
    // The atomic transition: a challenge that is not pending cannot be spent
    // again, whatever else has changed about the presentation.
    if (record.state !== 'pending') {
      return Promise.resolve({ status: 'already_consumed', challenge: record })
    }
    if (presentation.now >= record.expiresAt) {
      const expired: ConfirmationChallengeRecord = { ...record, state: 'expired' }
      this.records.set(record.id, expired)
      return Promise.resolve({ status: 'expired', challenge: expired })
    }
    const spent: ConfirmationChallengeRecord = {
      ...record,
      state: 'consumed',
      consumedAt: presentation.now,
    }
    this.records.set(record.id, spent)
    return Promise.resolve({ status: 'spent', challenge: spent })
  }

  stateOf(id: string): ConfirmationChallengeRecord | undefined {
    return this.records.get(id)
  }

  get issues(): number {
    return this.inserts.length
  }

  get consumeCalls(): number {
    return this.consumptions.length
  }
}

export interface ConfirmationsFixture {
  readonly store: AtomicChallengeStore
  readonly service: ConfirmationService
  readonly clock: ReturnType<typeof fakeClock>
}

/** The service, its store and its clock, all three inspectable. */
export function confirmations(ttlMs = 300_000): ConfirmationsFixture {
  const store = new AtomicChallengeStore()
  const clock = fakeClock()
  const service = new ConfirmationService({
    store,
    digestKey: DIGEST_KEY,
    clock: clock.now,
    random: fakeRandom(),
    ttlMs,
  })
  return { store, service, clock }
}

/** A tenant config that parses, so the graph is built and not cast. */
export function clientConfig(tenantId = TENANT): ClientConfig {
  return parseClientConfig({
    schema_version: '1.0.0',
    tenantId,
    environment: 'commerce_booking',
    presence: 'chat',
    capability: 'transact',
    region: 'ID',
    template: 'hospitality',
    branding: {
      businessName: 'Acme Hotels',
      theme: {
        accent: '#123456',
        surface: '#ffffff',
        ink: '#101010',
        radius: 'rounded',
        fontFamily: 'Inter',
      },
    },
    languages: [{ code: 'id', label: 'Bahasa Indonesia' }],
    primaryLanguage: 'id',
    updatedAt: '2026-04-01',
  })
}

/** A graph with the named actions enabled on it, built by the real reducer. */
export function graph(...enabled: readonly string[]): ContextGraph {
  const events: ContextEvent[] = [
    { type: 'action/set', actions: enabled.map((name) => ({ name, enabled: true })) },
  ]
  return foldContextEvents(seedContextGraph(clientConfig(), '/rooms'), events)
}

/**
 * A knowledge port that returns nothing, with an empty plan.
 *
 * `retrieve` is called on every turn, including the read-only catalog probe, so
 * the port has to be honest about having nothing rather than absent — and a
 * test about confirmation should not be refused for a knowledge gap.
 */
export const SILENT_KNOWLEDGE: KnowledgePort = {
  retrieve: () =>
    Promise.resolve({
      plan: { need: 'retrieval_knowledge', subjects: [], query: '' },
      context: [],
      deferToStructuredTruth: false,
    }),
}

/**
 * An entity resolver that answers "exists" for a fixed set of kinds and ids.
 *
 * `slot` and `customer` are what `booking.create`'s contract bears on, and
 * `booking` what `booking.reschedule`'s does, so the nominal inputs above pass
 * without a resolver that has an opinion about anything else.
 */
export const CONFIRMING: EntityResolver = {
  resolveExists: (_tenantId, entityKind, entityId): Promise<boolean> =>
    Promise.resolve(
      (entityKind === 'slot' && (entityId === 'slot_1' || entityId === 'slot_2')) ||
        (entityKind === 'customer' && entityId === 'cust_9') ||
        (entityKind === 'booking' && entityId === 'book_1'),
    ),
}

/** An executor that records every request it was handed, and succeeds. */
export function recordingExecutor(): ActionExecutor & {
  readonly calls: readonly {
    readonly action: string
    readonly inputs: Readonly<Record<string, unknown>>
  }[]
  readonly requests: readonly ActionExecutionRequest[]
} {
  const calls: { action: string; inputs: Readonly<Record<string, unknown>> }[] = []
  const requests: ActionExecutionRequest[] = []
  return {
    executorId: 'act-host-test-executor',
    execute(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
      calls.push({ action: request.action, inputs: request.inputs })
      requests.push(request)
      return Promise.resolve({ status: 'succeeded', output: { ok: true } })
    },
    get calls() {
      return calls
    },
    get requests() {
      return requests
    },
  }
}

/**
 * An executor whose provider answers with an outcome nobody can be sure of.
 *
 * A booking service that timed out has not failed the booking and has not made
 * it: the executor reports `failed` with a machine-readable code, which is the
 * only thing a provider that says nothing certain permits a caller to believe.
 * The calls are recorded so a test can assert the host asked once and did not
 * try a second write to find out.
 */
export function uncertainExecutor(): ActionExecutor & {
  readonly calls: readonly ActionExecutionRequest[]
} {
  const calls: ActionExecutionRequest[] = []
  return {
    executorId: 'act-host-test-uncertain-executor',
    execute(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
      calls.push(request)
      return Promise.resolve({
        status: 'failed',
        errorCode: 'provider_outcome_unknown',
        retryable: true,
        message: 'The booking service did not report an outcome.',
      })
    },
    get calls() {
      return calls
    },
  }
}

/** The gate every nominal case asks, as the default registry answers it. */
export function policy(): ActionPolicy {
  return new ActionPolicy()
}
