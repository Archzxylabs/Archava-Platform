import { describe, expect, it } from 'vitest'
import type { BrainReply, BrainTurn } from '@archava/adapters'
import { ReferenceBrain, requestAction } from '../src/brain.js'

/**
 * The utterance → action mapping, asserted directly.
 *
 * `requestAction` is exported for exactly this: the mapping is a claim the
 * reference tenant makes about what a visitor asked for, and it is worth making
 * that claim against the function rather than through a whole turn, where a
 * change to retrieval or the gate would obscure it. §16 is the part under test
 * here — a request is what the brain asks for, and whether it was permitted is a
 * question the gate answers, not this one.
 */

/** A page as the projection hands it over: ids and names, no graph. */
function pageWith(...names: readonly string[]): unknown {
  return names.map((name) => ({ id: name, name }))
}

describe('requested page action', () => {
  it('reads a comparison out of the words for one', () => {
    const request = requestAction('compare the treetop and the suite', pageWith('treetop', 'suite'))
    expect(request?.actionId).toBe('ui.compare')
    expect(request?.inputs).toEqual({ entityIds: ['treetop', 'suite'] })
  })

  it('reads a highlight out of the words for one', () => {
    const request = requestAction('show me the treetop suite', pageWith('treetop', 'suite'))
    expect(request?.actionId).toBe('ui.highlight')
    expect(request?.inputs).toEqual({ entityId: 'treetop' })
  })

  it('asks for the booking even though the tier only confirms it', () => {
    // The request goes out on its merits and the gate decides. A brain that
    // pre-checked the tier would be approving on the gate's behalf, and the
    // confirmation evidence §18 exists to produce would be a brain that never
    // asked.
    expect(requestAction('book me a room', pageWith('treetop'))?.actionId).toBe('booking.create')
  })

  it('asks for the payment even though it is above the configured capability', () => {
    expect(requestAction('I want to pay the deposit', pageWith('treetop'))?.actionId).toBe(
      'payment.initiate',
    )
  })

  it('asks for nothing when the utterance asks for nothing', () => {
    expect(requestAction('what does the treetop cost?', pageWith('treetop'))).toBeNull()
  })
})

describe('cancelling is not booking', () => {
  it('does not turn a cancellation into a request to make one', () => {
    // "cancel my booking" contains "booking", which contains "book", so the
    // create pattern matches it by substring. Left alone, a visitor asking to
    // undo a reservation is reported as asking to make one — the turn's action
    // summary would name the opposite of what was requested.
    expect(requestAction('cancel my booking', pageWith('treetop'))?.actionId).toBe('booking.cancel')
    expect(requestAction('I want to cancel my reservation', pageWith('treetop'))?.actionId).toBe(
      'booking.cancel',
    )
    expect(requestAction('please call off the booking', pageWith('treetop'))?.actionId).toBe(
      'booking.cancel',
    )
  })

  it('still reads a booking request as one', () => {
    // The guard runs first, so it must not swallow the intent it guards.
    expect(requestAction('book me a room', pageWith('treetop'))?.actionId).toBe('booking.create')
    expect(requestAction('reserve the treetop suite', pageWith('treetop'))?.actionId).toBe(
      'booking.create',
    )
  })

  it('reads a question about cancelling as its own request', () => {
    // What is cancellation policy? is a knowledge question wearing the word. The
    // pipeline answers it from published content; the id requested here is one
    // the ACL does not register, so the gate denies it as unregistered rather
    // than as out of tier — §18's "unregistered id is a denial, not a crash".
    expect(requestAction('what is your cancellation policy?', pageWith('treetop'))?.actionId).toBe(
      'booking.cancel',
    )
  })
})

describe('ReferenceBrain decorator', () => {
  /**
   * A brain that answers whatever it is asked, and asks for nothing itself.
   *
   * A complete `BrainReply`, with `deferToStructuredTruth` included, because the
   * field is what routes the turn: a provider that left it off would be a reply
   * the type already rejects, and a decorator test built on one would be passing
   * for a shape no real brain can return.
   */
  function answering(reply: string): BrainReply {
    return { text: reply, citations: [], requestedActions: [], deferToStructuredTruth: false }
  }

  const TURN: BrainTurn = {
    tenantId: 'acme-hotels',
    utterance: 'compare the treetop and the suite',
    locale: 'en',
    context: pageWith('treetop', 'suite') as Readonly<Record<string, unknown>>,
    grounding: [],
    permittedActionIds: ['ui.highlight', 'ui.compare'],
    structuredTruth: {},
    knowledgeMode: 'retrieval',
  }

  it('adds the request and leaves the reply alone', async () => {
    const brain = new ReferenceBrain(
      {
        providerId: 'probe',
        model: 'probe-model',
        health: { ready: true, reason: null },
        async reply(): Promise<BrainReply> {
          return answering('Two suites are available.')
        },
      },
      'reference',
    )
    const reply = await brain.reply(TURN)
    expect(reply.text).toBe('Two suites are available.')
    expect(reply.requestedActions).toEqual([
      { actionId: 'ui.compare', inputs: { entityIds: ['treetop', 'suite'] } },
    ])
  })

  it('leaves the reply untouched when nothing was asked for', async () => {
    const brain = new ReferenceBrain(
      {
        providerId: 'probe',
        model: 'probe-model',
        health: { ready: true, reason: null },
        async reply(): Promise<BrainReply> {
          return answering('The Treetop Suite is 2.4m IDR a night.')
        },
      },
      'reference',
    )
    const reply = await brain.reply({ ...TURN, utterance: 'what does the treetop cost?' })
    expect(reply.text).toBe('The Treetop Suite is 2.4m IDR a night.')
    expect(reply.requestedActions).toEqual([])
  })
})
