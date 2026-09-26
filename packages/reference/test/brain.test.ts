import { describe, expect, it } from 'vitest'
import type { BrainProvider, BrainReply, BrainTurn } from '@archava/adapters'
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
        reply(): Promise<BrainReply> {
          return Promise.resolve(answering('Two suites are available.'))
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
        reply(): Promise<BrainReply> {
          return Promise.resolve(answering('The Treetop Suite is 2.4m IDR a night.'))
        },
      },
      'reference',
    )
    const reply = await brain.reply({ ...TURN, utterance: 'what does the treetop cost?' })
    expect(reply.text).toBe('The Treetop Suite is 2.4m IDR a night.')
    expect(reply.requestedActions).toEqual([])
  })
})

/**
 * A question about the page, answered from the page.
 *
 * The E2E asked "What am I looking at?" and got an answer grounded in the
 * check-in policy: a real sentence, about a subject nobody had asked about. The
 * projection already hands the brain the visible entities and the section
 * heading, so the answer was available and went unused. These assert that the
 * decorator uses it — and, because the phrases are matched whole, that it does
 * not start answering availability questions with a list of room names.
 */
describe('what the page is showing', () => {
  /** A brain that says exactly what it was handed, and asks for nothing. */
  function saying(text: string): BrainProvider {
    return {
      providerId: 'probe',
      model: 'probe-model',
      health: { ready: true, reason: null },
      reply(): Promise<BrainReply> {
        return Promise.resolve(answering(text))
      },
    }
  }

  function answering(text: string): BrainReply {
    return { text, citations: [], requestedActions: [], deferToStructuredTruth: false }
  }

  const TURN: BrainTurn = {
    tenantId: 'acme-hotels',
    utterance: 'what am I looking at?',
    locale: 'en',
    context: {
      section: 'Rooms',
      entities: [
        { id: 'garden-twin', name: 'Garden Twin Room', entityKind: 'unknown' },
        { id: 'deluxe-valley', name: 'Deluxe Valley Room', entityKind: 'unknown' },
      ],
    },
    grounding: [],
    permittedActionIds: ['ui.highlight', 'ui.compare'],
    structuredTruth: {},
    knowledgeMode: 'retrieval',
  }

  /**
   * A turn whose page context is a bare entity list, not a
   * `{ section, entities }` record.
   *
   * The cast is the point of the helper. `BrainTurn.context` is typed as a
   * record because that is what the projection sends, and `pageEntities` reads
   * that record — but it also accepts a bare list, and a host that sent one
   * used to reach the brain unlabelled. Pinning that branch means handing the
   * brain a value the port's type does not describe, so the cast says so out
   * loud rather than loosening the port's type to hide it.
   */
  function turnListing(...names: readonly string[]): BrainTurn {
    return { ...TURN, context: pageWith(...names) as Readonly<Record<string, unknown>> }
  }

  it('names what the visitor is actually looking at', async () => {
    const brain = new ReferenceBrain(saying('Our check-in is from 2pm.'), 'reference')
    const reply = await brain.reply(TURN)
    expect(reply.text).toBe(
      'The Rooms section is showing 2: Garden Twin Room and Deluxe Valley Room.',
    )
  })

  it('says "this page" when the host set no section heading', async () => {
    const brain = new ReferenceBrain(saying('Our check-in is from 2pm.'), 'reference')
    const reply = await brain.reply(turnListing('garden-twin', 'deluxe-valley'))
    expect(reply.text).toBe('This page is showing 2: garden-twin and deluxe-valley.')
  })

  it('describes a single visible thing without a list', async () => {
    const brain = new ReferenceBrain(saying('Our check-in is from 2pm.'), 'reference')
    const reply = await brain.reply(turnListing('garden-twin'))
    expect(reply.text).toBe('This page is showing 1: garden-twin.')
  })

  it('asks for no action, because a question is not a request', async () => {
    const brain = new ReferenceBrain(saying('Our check-in is from 2pm.'), 'reference')
    const reply = await brain.reply(TURN)
    expect(reply.requestedActions).toEqual([])
  })

  it('leaves the inner reply standing when the page shows nothing', async () => {
    const brain = new ReferenceBrain(saying('Our check-in is from 2pm.'), 'reference')
    const reply = await brain.reply({ ...TURN, context: { section: 'Rooms', entities: [] } })
    expect(reply.text).toBe('Our check-in is from 2pm.')
  })

  it.each([
    'what can I book this week?',
    'what can I see for breakfast?',
    'how much is the garden twin?',
    'what is your cancellation policy?',
  ])('does not answer %j from the page', async (utterance) => {
    const brain = new ReferenceBrain(saying('The inner brain answered this one.'), 'reference')
    const reply = await brain.reply({ ...TURN, utterance })
    expect(reply.text).toBe('The inner brain answered this one.')
  })

  it('understands the question in Indonesian too', async () => {
    const brain = new ReferenceBrain(saying('Our check-in is from 2pm.'), 'reference')
    const reply = await brain.reply({ ...TURN, utterance: 'ini halaman apa?' })
    expect(reply.text).toBe(
      'The Rooms section is showing 2: Garden Twin Room and Deluxe Valley Room.',
    )
  })
})
