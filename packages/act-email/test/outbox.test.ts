/**
 * The outbox boundary, exercised with offline fakes.
 *
 * Nothing here talks to a mail provider, a database, or a network. The store is
 * a Map that enforces the same atomicity a production store must, the transport
 * is a scripted responder, and the status port is a lookup that can be told to
 * answer or to stay silent. That is the point: every guarantee below is a
 * guarantee about *this package's decisions*, not about any vendor, and none of
 * them is a demonstration of real delivery.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { EmailOutboxBoundary } from '../src/outbox.js'
import {
  EMAIL_IDEMPOTENCY_CONFLICT,
  isEmailAddress,
  isProviderMessageId,
  isTrustedTemplateShape,
  type ApprovedEmailTemplate,
  type EmailAttemptRecord,
  type EmailAttemptStore,
  type EmailDeliveryStatusPort,
  type EmailGateway,
  type EmailGatewayOutcome,
  type EmailSendRequest,
} from '../src/index.js'
import {
  FakeStatusPort,
  FakeTransport,
  KEY,
  OTHER_TENANT,
  RecordingStore,
  RECIPIENT,
  sendOf,
  storageKey,
  TENANT_A,
  TEMPLATE_A,
} from './fakes.js'

/**
 * The server-side key the fingerprint is computed with.
 *
 * What it stands in for is a deployment secret that must survive a restart: a
 * fingerprint taken under a different key is a different payload as far as the
 * boundary is concerned, which would turn every replay into a conflict.
 */
const FINGERPRINT_KEY = new Uint8Array(32).fill(7)

function boundary(
  store: EmailAttemptStore,
  gateway: EmailGateway,
  status?: EmailDeliveryStatusPort,
) {
  return new EmailOutboxBoundary({
    gateway,
    store,
    status: status ?? new FakeStatusPort(),
    fingerprintKey: FINGERPRINT_KEY,
  })
}

describe('email outbox boundary', () => {
  // ---- one key, one send -------------------------------------------------

  it('issues exactly one send for a key and replays the provider id', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    const first = await subject.send(sendOf())
    const replay = await subject.send(sendOf())

    expect(first).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-1' })
    expect(replay).toEqual(first)
    expect(transport.calls).toHaveLength(1)
  })

  it('serves an accepted replay from the record without touching the status port', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    await subject.send(sendOf())
    status.response = { outcome: 'accepted', providerMessageId: 'different-id' }

    const replay = await subject.send(sendOf())

    // The stored receipt is authoritative on its own. A second opinion is not
    // consulted, so a status port that disagreed could not rewrite it.
    expect(replay).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-1' })
    expect(status.lookups).toHaveLength(0)
  })

  it('replays a rejected attempt as a refusal with no second send', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    transport.response = { outcome: 'rejected', reason: 'provider_declined' }
    const subject = boundary(store, transport)

    const first = await subject.send(sendOf())
    const replay = await subject.send(sendOf())

    expect(first).toEqual({ outcome: 'rejected', reason: 'provider_declined' })
    expect(replay).toMatchObject({ outcome: 'rejected' })
    expect(transport.calls).toHaveLength(1)
  })

  // ---- same key, different payload --------------------------------------

  it('refuses a changed recipient under the same key', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    await subject.send(sendOf())
    const conflict = await subject.send(sendOf({ recipient: 'someone-else@example.com' }))

    expect(conflict).toEqual({ outcome: 'rejected', reason: EMAIL_IDEMPOTENCY_CONFLICT })
    expect(transport.calls).toHaveLength(1)
  })

  it('refuses a changed template under the same key', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    await subject.send(sendOf())
    const conflict = await subject.send(
      sendOf({
        template: {
          ...TEMPLATE_A,
          templateId: 'other-template',
          providerTemplateId: 'provider-template-2',
        },
      }),
    )

    expect(conflict).toEqual({ outcome: 'rejected', reason: EMAIL_IDEMPOTENCY_CONFLICT })
    expect(transport.calls).toHaveLength(1)
  })

  it('refuses a template that resolves to a different sender under the same key', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    await subject.send(sendOf())
    const conflict = await subject.send(
      sendOf({ template: { ...TEMPLATE_A, senderAddress: 'forged@example.com' } }),
    )

    expect(conflict).toEqual({ outcome: 'rejected', reason: EMAIL_IDEMPOTENCY_CONFLICT })
    expect(transport.calls).toHaveLength(1)
  })

  it('still refuses a conflict after the attempt went out', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    await subject.send(sendOf())
    const conflict = await subject.send(sendOf({ recipient: 'forged@example.com' }))

    // A conflict is not a success, and it is not answered with the first
    // message's receipt either: it is refused.
    expect(conflict.outcome).toBe('rejected')
    expect(JSON.stringify(conflict)).not.toContain('opaque-1')
  })

  // ---- tenant scope ------------------------------------------------------

  it('keeps cross-tenant keys independent', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    const a = await subject.send(sendOf())
    const b = await subject.send(
      sendOf({
        tenantId: OTHER_TENANT,
        template: { ...TEMPLATE_A, tenantId: OTHER_TENANT },
        recipient: 'other@example.com',
      }),
    )
    const bAgain = await subject.send(
      sendOf({
        tenantId: OTHER_TENANT,
        template: { ...TEMPLATE_A, tenantId: OTHER_TENANT },
        recipient: 'other@example.com',
      }),
    )

    // Each tenant got its own send, and each replay only replayed its own.
    expect(a).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-1' })
    expect(b).toEqual(a)
    expect(bAgain).toEqual(b)
    expect(transport.calls).toHaveLength(2)
    expect(new Set(transport.calls.map((call) => call.tenantId))).toEqual(
      new Set([TENANT_A, OTHER_TENANT]),
    )
  })

  it('never carries one tenant id into another tenant call', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    // Two tenants, the same idempotency key, and both attempts left open by a
    // transport that never answered. A replay of each therefore has to ask the
    // status port whose attempt it is, and the port is where a tenant id that
    // leaked across tenants would show up.
    transport.throws = true
    await subject.send(sendOf())
    await subject.send(
      sendOf({ tenantId: OTHER_TENANT, template: { ...TEMPLATE_A, tenantId: OTHER_TENANT } }),
    )
    transport.throws = false
    status.response = { outcome: 'unknown', reason: 'still_waiting' }
    await subject.send(sendOf())
    await subject.send(
      sendOf({ tenantId: OTHER_TENANT, template: { ...TEMPLATE_A, tenantId: OTHER_TENANT } }),
    )

    // Two lookups for one key, one per tenant, each carrying its own tenant id.
    expect(status.lookups).toHaveLength(2)
    expect(new Set(status.lookups.map((lookup) => lookup.tenantId))).toEqual(
      new Set([TENANT_A, OTHER_TENANT]),
    )
    expect(status.lookups.every((lookup) => lookup.idempotencyKey === KEY)).toBe(true)
    // And the recipient never reaches the port: the fingerprint is a digest of
    // the payload, not the payload.
    for (const lookup of status.lookups) {
      expect(JSON.stringify(lookup)).not.toContain(RECIPIENT)
      expect(lookup.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(new Set(transport.calls.map((call) => call.tenantId))).toEqual(
      new Set([TENANT_A, OTHER_TENANT]),
    )
  })

  it('catches a store that ignored the tenant scope', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    await subject.send(sendOf())
    // A store that answered loosely would hand back tenant-a's record for a
    // tenant-b key. The boundary's own fingerprint check still catches it,
    // because that record was computed from a different tenant.
    const otherAttempt: EmailAttemptRecord = {
      tenantId: OTHER_TENANT,
      idempotencyKey: KEY,
      fingerprint: 'fingerprint-from-tenant-a',
      state: 'accepted',
      providerMessageId: 'opaque-1',
    }
    // The loose store hands back this record for a tenant-b key.
    store.update(otherAttempt)
    const conflict = await subject.send(
      sendOf({ tenantId: OTHER_TENANT, template: { ...TEMPLATE_A, tenantId: OTHER_TENANT } }),
    )

    expect(conflict).toEqual({ outcome: 'rejected', reason: EMAIL_IDEMPOTENCY_CONFLICT })
  })

  // ---- ambiguous outcomes -------------------------------------------------

  it('stays unknown when the transport times out and does not send again', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    transport.throws = true
    const first = await subject.send(sendOf())

    // The provider is silent now. A replay must not go back to the provider.
    transport.throws = false
    const replay = await subject.send(sendOf())

    expect(first).toEqual({ outcome: 'unknown', reason: 'email_provider_did_not_answer' })
    // The status port's own machine reason, relayed and not re-invented. What it
    // is not is a receipt, and what it does not come with is a second send.
    expect(replay).toEqual({ outcome: 'unknown', reason: 'status_not_available' })
    expect(transport.calls).toHaveLength(1)
    expect(store.attempts.get(storageKey(sendOf()))?.state).toBe('unknown')
    expect(status.lookups).toHaveLength(1)
  })

  it('resolves an unknown attempt from a later authoritative status lookup', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    transport.throws = true
    await subject.send(sendOf())

    transport.throws = false
    status.response = { outcome: 'accepted', providerMessageId: 'opaque-late' }
    const resolved = await subject.send(sendOf())

    expect(resolved).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-late' })
    expect(transport.calls).toHaveLength(1)
    expect(store.attempts.get(storageKey(sendOf()))).toMatchObject({
      state: 'accepted',
      providerMessageId: 'opaque-late',
    })
    // And now the receipt is served from the record, with no further lookups.
    expect(await subject.send(sendOf())).toEqual(resolved)
    expect(status.lookups).toHaveLength(1)
  })

  it('treats a status port that cannot answer as unknown, never as a success', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    transport.throws = true
    await subject.send(sendOf())
    transport.throws = false
    status.throws = true
    const replay = await subject.send(sendOf())

    expect(replay).toEqual({ outcome: 'unknown', reason: 'email_attempt_not_reconciled' })
    expect(transport.calls).toHaveLength(1)
  })

  it('records a malformed receipt as unknown rather than as a success', async () => {
    for (const malformed of [
      { outcome: 'accepted' },
      { outcome: 'accepted', providerMessageId: '' },
      { outcome: 'accepted', providerMessageId: RECIPIENT },
      { outcome: 'accepted', providerMessageId: 'guest@example.com <mailto:guest@example.com>' },
    ]) {
      const store = new RecordingStore()
      const transport = new FakeTransport()
      const subject = boundary(store, transport)
      transport.response = malformed as EmailGatewayOutcome

      const result = await subject.send(sendOf())
      const replay = await subject.send(sendOf())

      expect(result.outcome).toBe('unknown')
      expect(replay.outcome).toBe('unknown')
      expect(transport.calls).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain(RECIPIENT)
    }
  })

  it('flattens a provider reason that carries a recipient', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)
    transport.response = {
      outcome: 'rejected',
      reason: `Hard bounce for ${RECIPIENT}: mailbox is full`,
    }

    const result = await subject.send(sendOf())

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'email_outcome_unexplained',
    })
    expect(JSON.stringify(result)).not.toContain(RECIPIENT)
  })

  it('does not relay a snake-case provider reason that may encode private data', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)
    transport.response = { outcome: 'rejected', reason: 'guest_example_com' }

    expect(await subject.send(sendOf())).toEqual({
      outcome: 'rejected',
      reason: 'email_outcome_unexplained',
    })
  })

  // ---- process restart ----------------------------------------------------

  it('replays from a store another boundary survived the restart with', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const beforeRestart = boundary(store, transport)
    await beforeRestart.send(sendOf())

    // A process that restarted mid-life, given the same durable store. Not the
    // same boundary object: a different one, with its own fresh gateway wiring.
    const status = new FakeStatusPort()
    const afterRestart = new EmailOutboxBoundary({
      gateway: transport,
      store,
      status,
      fingerprintKey: FINGERPRINT_KEY,
    })

    const replay = await afterRestart.send(sendOf())

    expect(replay).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-1' })
    expect(transport.calls).toHaveLength(1)
    expect(status.lookups).toHaveLength(0)
  })

  it('stores a keyed fingerprint that cannot be reproduced by plain SHA-256', async () => {
    const store = new RecordingStore()
    await boundary(store, new FakeTransport()).send(sendOf())
    const fingerprint = store.attempts.get(storageKey(sendOf()))?.fingerprint
    const payload = JSON.stringify([
      TENANT_A,
      RECIPIENT,
      TEMPLATE_A.templateId,
      TEMPLATE_A.providerTemplateId,
      TEMPLATE_A.senderAddress,
    ])
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fingerprint).not.toBe(createHash('sha256').update(payload).digest('hex'))
    const otherStore = new RecordingStore()
    const otherKey = new Uint8Array(32).fill(8)
    await new EmailOutboxBoundary({
      gateway: new FakeTransport(),
      store: otherStore,
      status: new FakeStatusPort(),
      fingerprintKey: otherKey,
    }).send(sendOf())
    expect(otherStore.attempts.get(storageKey(sendOf()))?.fingerprint).not.toBe(fingerprint)
  })

  it('requires a strong server key instead of accepting an empty fingerprint key', () => {
    expect(
      () =>
        new EmailOutboxBoundary({
          gateway: new FakeTransport(),
          store: new RecordingStore(),
          status: new FakeStatusPort(),
          fingerprintKey: new Uint8Array(8),
        }),
    ).toThrow(TypeError)
  })

  it('does not re-send for a restarted process that had an open attempt', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    // A first process answered, and the record it left is what a real store would
    // still hold — including this boundary's own fingerprint of the payload.
    await subject.send(sendOf())
    const settled = store.attempts.get(storageKey(sendOf()))
    expect(settled?.state).toBe('accepted')

    // The same record as a process that died between claiming the key and hearing
    // anything back would have left it: still `prepared`, no receipt. The
    // boundary that picks it up is a different object, as a restarted process
    // would be.
    store.update({ ...settled, state: 'prepared' } as EmailAttemptRecord)
    const restarted = new EmailOutboxBoundary({
      gateway: transport,
      store,
      status,
      fingerprintKey: FINGERPRINT_KEY,
    })
    status.response = { outcome: 'unknown', reason: 'still_waiting' }

    const replay = await restarted.send(sendOf())

    // Nobody knows, so nothing is sent and nothing is reported as sent. The only
    // thing the restarted boundary may do is ask the status port, and its answer
    // is relayed as-is.
    expect(replay).toEqual({ outcome: 'unknown', reason: 'still_waiting' })
    expect(transport.calls).toHaveLength(1)
    expect(status.lookups).toHaveLength(1)
  })

  // ---- simulated concurrency ----------------------------------------------

  it('gives a key to exactly one of two concurrent callers', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    // Both callers reach claim() before either one is answered. The store's atom
    // is what decides, and only one of them is told to send.
    const [first, second] = await Promise.all([subject.send(sendOf()), subject.send(sendOf())])

    expect(store.claimCalls).toBe(2)
    expect(transport.calls).toHaveLength(1)
    expect(first).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-1' })
    // The loser is a replay of a record the winner has not settled yet, so the
    // status port is the only thing allowed to speak — and it says nothing.
    expect(second.outcome).toBe('unknown')
  })

  it('reports unknown for a concurrent caller while the send is still in flight', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowTransport: EmailGateway = {
      async send(request: EmailSendRequest): Promise<EmailGatewayOutcome> {
        transport.calls.push(request)
        await gate
        return transport.response
      },
    }
    const slow = boundary(store, slowTransport, status)

    const first = slow.send(sendOf())
    const second = slow.send(sendOf())
    release()
    const [, secondResult] = await Promise.all([first, second])

    expect(transport.calls).toHaveLength(1)
    expect(secondResult.outcome).toBe('unknown')
  })

  it('does not freeze a stale status rejection while the direct send is in flight', async () => {
    const store = new RecordingStore()
    const status = new FakeStatusPort()
    status.response = { outcome: 'rejected', reason: 'provider_declined' }
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport: EmailGateway = {
      async send() {
        markStarted()
        await gate
        return { outcome: 'accepted', providerMessageId: 'opaque-direct' }
      },
    }
    const subject = boundary(store, transport, status)

    const first = subject.send(sendOf())
    await started
    expect(await subject.send(sendOf())).toEqual({
      outcome: 'unknown',
      reason: 'email_attempt_not_reconciled',
    })
    expect(store.attempts.get(storageKey(sendOf()))?.state).toBe('prepared')
    release()
    expect(await first).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-direct' })
    expect(await subject.send(sendOf())).toEqual({
      outcome: 'accepted',
      providerMessageId: 'opaque-direct',
    })
  })

  // ---- stores that cannot answer ------------------------------------------

  it('reports unknown when the store refuses the claim', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const subject = boundary(store, transport)

    store.throwOnClaim = true
    const result = await subject.send(sendOf())

    expect(result).toEqual({ outcome: 'unknown', reason: 'email_attempt_store_unavailable' })
    // Nothing was sent, and nothing is described as sent.
    expect(transport.calls).toHaveLength(0)
  })

  it('keeps a direct provider receipt true when its store settlement fails', async () => {
    const store = new RecordingStore()
    const status = new FakeStatusPort()
    const transport: EmailGateway = {
      send() {
        store.throwOnSettle = true
        return Promise.resolve({ outcome: 'accepted', providerMessageId: 'opaque-direct' })
      },
    }
    const subject = boundary(store, transport, status)

    expect(await subject.send(sendOf())).toEqual({
      outcome: 'accepted',
      providerMessageId: 'opaque-direct',
    })
    expect(store.attempts.get(storageKey(sendOf()))?.state).toBe('prepared')

    store.throwOnSettle = false
    status.response = { outcome: 'accepted', providerMessageId: 'opaque-direct' }
    expect(await subject.send(sendOf())).toEqual({
      outcome: 'accepted',
      providerMessageId: 'opaque-direct',
    })
    expect(store.attempts.get(storageKey(sendOf()))?.state).toBe('accepted')
  })

  it('does not report a status receipt that failed to become the durable record', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    transport.throws = true
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)
    await subject.send(sendOf())
    status.response = { outcome: 'accepted', providerMessageId: 'opaque-late' }
    store.throwOnSettle = true

    expect(await subject.send(sendOf())).toEqual({
      outcome: 'unknown',
      reason: 'email_attempt_settlement_unconfirmed',
    })
    expect(store.attempts.get(storageKey(sendOf()))?.state).toBe('unknown')
    expect(transport.calls).toHaveLength(1)
  })

  it('does not return a status receipt after another settlement wins the race', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    transport.throws = true
    const status: EmailDeliveryStatusPort = {
      statusPortId: 'racing-status-port',
      status() {
        const previous = store.attempts.get(storageKey(sendOf()))
        if (previous !== undefined) store.update({ ...previous, state: 'rejected' })
        return Promise.resolve({ outcome: 'accepted', providerMessageId: 'opaque-stale' })
      },
    }
    const subject = boundary(store, transport, status)
    await subject.send(sendOf())

    expect(await subject.send(sendOf())).toEqual({
      outcome: 'unknown',
      reason: 'email_attempt_settlement_unconfirmed',
    })
    expect(store.attempts.get(storageKey(sendOf()))?.state).toBe('rejected')
    expect(transport.calls).toHaveLength(1)
  })

  it('keeps a receipt when a late settlement is refused', async () => {
    const store = new RecordingStore()
    const transport = new FakeTransport()
    const status = new FakeStatusPort()
    const subject = boundary(store, transport, status)

    transport.throws = true
    await subject.send(sendOf())

    // The provider answers late, through the status port, and that settlement
    // lands first. A second process settling `unknown` from the old state must
    // not be able to erase it.
    status.response = { outcome: 'accepted', providerMessageId: 'opaque-late' }
    const resolved = await subject.send(sendOf())
    expect(resolved).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-late' })

    const stale = await subject.send(sendOf({ idempotencyKey: KEY, recipient: RECIPIENT }))
    expect(stale).toEqual({ outcome: 'accepted', providerMessageId: 'opaque-late' })
  })

  // ---- the request itself -------------------------------------------------

  it('refuses a request it cannot vouch for without asking the provider', async () => {
    for (const bad of [
      sendOf({ recipient: 'not-an-address' }),
      sendOf({ recipient: '' }),
      sendOf({ template: { ...TEMPLATE_A, approved: false } as unknown as ApprovedEmailTemplate }),
      sendOf({ template: { ...TEMPLATE_A, senderAddress: 'not-an-address' } }),
      sendOf({ tenantId: '' }),
      sendOf({ idempotencyKey: '  ' }),
    ]) {
      const store = new RecordingStore()
      const transport = new FakeTransport()
      const subject = boundary(store, transport)
      const result = await subject.send(bad)
      expect(result.outcome).toBe('rejected')
      expect(transport.calls).toHaveLength(0)
      expect(store.attempts.size).toBe(0)
    }
  })
})

/**
 * The shared shape checks the boundary relies on, kept next to the tests that
 * depend on them so the two cannot drift.
 */
describe('payload and identifier shape', () => {
  it('rejects anything a receipt must not be', () => {
    for (const value of ['', 'guest@example.com', 'a b', '<guest@example.com>', 'x'.repeat(129)]) {
      expect(isProviderMessageId(value)).toBe(false)
    }
    expect(isProviderMessageId('opaque-1')).toBe(true)
  })

  it('keeps sender and body out of the shape it will trust', () => {
    expect(isEmailAddress(RECIPIENT)).toBe(true)
    expect(isEmailAddress('nope')).toBe(false)
    expect(isTrustedTemplateShape({ ...TEMPLATE_A, senderAddress: 'not-an-address' })).toBe(false)
    expect(isTrustedTemplateShape(Object.assign([], TEMPLATE_A))).toBe(false)
  })
})
