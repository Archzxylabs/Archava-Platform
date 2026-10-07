/**
 * The visitor envelope, exercised as a hostile input.
 *
 * Every case here is a thing a browser *can* send, and the assertion is always
 * the same shape: either the reader refused it structurally, or it returned a
 * narrow object from which every server-owned field is gone. Nothing reaches a
 * store, a provider or a clock — the envelope module has no such collaborators,
 * which is the point.
 *
 * The list that makes these tests meaningful is
 * {@link SERVER_OWNED_ENVELOPE_FIELDS} itself: the tests walk it rather than
 * restating it, so a server-owned field added to that constant is covered by
 * every smuggling case below without anybody having to remember to write a
 * test for it.
 */

import { describe, expect, it } from 'vitest'
import {
  SERVER_OWNED_ENVELOPE_FIELDS,
  VISITOR_ENVELOPE_REASONS,
  VisitorEnvelopeError,
  readVisitorEnvelope,
  type VisitorEnvelopeReason,
} from '../src/index.js'

/** A nominal envelope, with everything a visitor may legitimately send. */
function envelope(): Record<string, unknown> {
  return {
    utterance: 'book me the room nearest the beach',
    action: { actionId: 'booking.create', inputs: { slotId: 'slot_1' } },
  }
}

/** Anything an envelope might carry that only the server is allowed to say. */
function serverOwnedValues(): Record<string, unknown> {
  return {
    tenantId: 'someone-elses-hotel',
    sessionId: 'someone-elses-session',
    occurredAt: '2026-01-01T00:00:00.000Z',
    capability: 'enterprise',
    role: 'owner',
    confirmedActionIds: ['booking.create'],
    humanApprovedActionIds: ['admin.config.update'],
    permissionToken: 'signed-token',
    policy: 'allow',
    modelConfidence: 0.99,
    confidence: 1,
    toolCalls: [{ name: 'booking.create', inputs: { slotId: 'slot_1' } }],
    executor: { execute: () => ({ status: 'succeeded', output: {} }) },
    digestKey: 'key',
    clientSensitiveFields: ['notes'],
  }
}

describe('readVisitorEnvelope', () => {
  it('reads exactly what a visitor owns, and nothing else', () => {
    const reading = readVisitorEnvelope(envelope())

    expect(reading.envelope).toEqual({
      utterance: 'book me the room nearest the beach',
      action: { actionId: 'booking.create', inputs: { slotId: 'slot_1' } },
    })
    expect(reading.dropped).toEqual([])
  })

  it('carries a confirmation presentation when one is presented', () => {
    const reading = readVisitorEnvelope({
      ...envelope(),
      confirmation: { challengeId: 'challenge_1', token: 'token_1' },
    })

    expect(reading.envelope.confirmation).toEqual({ challengeId: 'challenge_1', token: 'token_1' })
  })

  it('drops every server-owned field, by name and never by value', () => {
    // One key at a time, so a field renamed in the constant cannot hide behind a
    // neighbour that happens to be dropped.
    for (const field of SERVER_OWNED_ENVELOPE_FIELDS) {
      const reading = readVisitorEnvelope({ ...envelope(), [field]: 'anything at all' })

      expect(reading.dropped, `${field} must be reported as dropped`).toContain(field)
      // The name survives into the audit trail; the value does not survive at all.
      expect(JSON.stringify(reading.envelope)).not.toContain(field)
      expect(JSON.stringify(reading.envelope)).not.toContain('anything at all')
    }
  })

  it('drops a confirmation verdict even when it names the confirmed action and no tokens are presented', () => {
    const reading = readVisitorEnvelope({ ...envelope(), ...serverOwnedValues() })

    expect(reading.dropped).toEqual(
      expect.arrayContaining(['confirmedActionIds', 'modelConfidence', 'permissionToken']),
    )
    expect(Object.keys(reading.envelope)).toEqual(['utterance', 'action'])
  })

  it('drops a second action candidate rather than queueing it', () => {
    // The reader is an allowlist of one action: `actions` is not a field it reads,
    // so a second candidate is reported by name and never becomes one. The
    // refusal below is the *shape* contract, not a queueing contract — a browser
    // that sends two gets the one, and an audit trail naming the other.
    const array = readVisitorEnvelope({
      ...envelope(),
      actions: [{ actionId: 'booking.create', inputs: { slotId: 'slot_1' } }],
    })
    expect(array.dropped).toContain('unrecognized_field')
    expect(Object.keys(array.envelope)).toEqual(['utterance', 'action'])

    const sibling = readVisitorEnvelope({
      ...envelope(),
      alsoAction: { actionId: 'email.send', inputs: {} },
    })
    expect(sibling.dropped).toContain('unrecognized_field')
    expect(sibling.envelope.action.actionId).toBe('booking.create')
    expect(JSON.stringify(sibling.envelope)).not.toContain('email.send')

    // No action field at all is a refusable shape, not an empty queue.
    expect(() => readVisitorEnvelope({ utterance: 'do two things', actions: [] })).toThrow(
      VisitorEnvelopeError,
    )
  })

  it('never records an unknown field name that itself carries sensitive data', () => {
    const secretName = 'card-4111-1111-1111-1111'
    const reading = readVisitorEnvelope({ ...envelope(), [secretName]: true })
    expect(reading.dropped).toEqual(['unrecognized_field'])
    expect(JSON.stringify(reading)).not.toContain(secretName)
  })

  it('refuses anything that is not a plain object', () => {
    for (const value of [null, undefined, 42, 'book this', true, [], () => undefined]) {
      expect(() => readVisitorEnvelope(value)).toThrow(VisitorEnvelopeError)
    }
  })

  it('refuses an envelope with no utterance field at all', () => {
    expect(() =>
      readVisitorEnvelope({ action: { actionId: 'booking.create', inputs: {} } }),
    ).toThrow(VisitorEnvelopeError)
  })

  it('refuses a confirmation carrying only one of its two halves', () => {
    expect(() =>
      readVisitorEnvelope({ ...envelope(), confirmation: { challengeId: 'challenge_1' } }),
    ).toThrow(VisitorEnvelopeError)
    expect(() =>
      readVisitorEnvelope({ ...envelope(), confirmation: { token: 'token_1' } }),
    ).toThrow(VisitorEnvelopeError)
  })

  it('refuses an action id past the id ceiling rather than truncating it', () => {
    expect(() =>
      readVisitorEnvelope({ utterance: '', action: { actionId: 'a'.repeat(257), inputs: {} } }),
    ).toThrow(VisitorEnvelopeError)
  })

  it('reports its reasons from a closed list, so a refusal is never a surprise', () => {
    const known = new Set<string>(VISITOR_ENVELOPE_REASONS)
    const observed = new Set<VisitorEnvelopeReason>()
    const cases: unknown[] = [
      null,
      { action: { actionId: 'a', inputs: {} } },
      { utterance: '' },
      { utterance: '', action: 'not an object' },
      { utterance: '', action: { actionId: 'booking.create', inputs: {} }, confirmation: 7 },
    ]

    for (const value of cases) {
      try {
        readVisitorEnvelope(value)
      } catch (error) {
        if (error instanceof VisitorEnvelopeError) observed.add(error.reason)
      }
    }

    // Every reason the module can raise was seen, and nothing outside the list
    // exists: a reason is a code a caller switches on, not a sentence.
    expect([...observed].sort()).toEqual([...VISITOR_ENVELOPE_REASONS].sort())
    expect(known.has('not_an_object')).toBe(true)
  })
})
