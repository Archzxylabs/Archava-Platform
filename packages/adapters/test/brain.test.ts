import { describe, expect, it } from 'vitest'
import { ScriptedBrain, type BrainTurn } from '../src/index.js'

/**
 * A brain turn as the pipeline builds one.
 *
 * `structuredTruth` and `knowledgeMode` are required by the port (§17): a brain
 * cannot be told to prefer live values over chunks unless the caller says both
 * that it was handed values and which of the three sources this turn is.
 */
function turn(overrides: Partial<BrainTurn> = {}): BrainTurn {
  return {
    tenantId: 'tenant-acme',
    utterance: 'What is your return policy?',
    locale: 'en',
    context: {},
    grounding: [],
    permittedActionIds: [],
    structuredTruth: {},
    knowledgeMode: 'retrieval',
    ...overrides,
  }
}

/**
 * The reference brain is the one an operator reads to agree on what the real one
 * must do, so its tests are all about the contract a `BrainProvider` keeps: it
 * answers from what it was handed, it cites what it answered from, and it says
 * "I don't know" rather than making something up.
 */
describe('ScriptedBrain', () => {
  it('answers an exact scripted match', async () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { 'return policy': 'You have 30 days.' },
    })

    const reply = await brain.reply(turn({ utterance: 'What is your return policy?' }))

    expect(reply.text).toBe('You have 30 days.')
    expect(reply.deferToStructuredTruth).toBe(false)
    expect(reply.requestedActions).toEqual([])
  })

  it('matches case-insensitively on a substring', async () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { 'return policy': 'You have 30 days.' },
    })

    const reply = await brain.reply(turn({ utterance: 'tell me about the RETURN POLICY please' }))

    expect(reply.text).toBe('You have 30 days.')
  })

  it('answers from authored knowledge when no script matches', async () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })
    const reply = await brain.reply(
      turn({
        grounding: [
          {
            sourceId: 'doc_1',
            sourceTitle: 'Shipping',
            sourceKind: 'faq',
            text: 'We ship within Indonesia in 2-4 days.',
          },
        ],
      }),
    )

    expect(reply.text).toBe('We ship within Indonesia in 2-4 days.')
    expect(reply.citations).toEqual([{ sourceId: 'doc_1', sourceTitle: 'Shipping' }])
    expect(reply.deferToStructuredTruth).toBe(false)
  })

  it('cites every chunk it was handed, not just the one it read', async () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })
    const reply = await brain.reply(
      turn({
        grounding: [
          { sourceId: 'doc_1', sourceTitle: 'Shipping', sourceKind: 'faq', text: 'a' },
          { sourceId: 'doc_2', sourceTitle: 'Returns', sourceKind: 'policy', text: 'b' },
        ],
      }),
    )

    // §17's eval trail depends on the citation list being the whole retrieval
    // result, not the part an answer happened to lean on.
    expect(reply.citations.map((citation) => citation.sourceId)).toEqual(['doc_1', 'doc_2'])
  })

  it('declines rather than inventing an answer', async () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })

    const reply = await brain.reply(turn({ utterance: 'where is my order' }))

    expect(reply.deferToStructuredTruth).toBe(true)
    expect(reply.citations).toEqual([])
    expect(reply.text).not.toHaveLength(0)
  })

  it('honours an explicit fallback', async () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      fallback: 'Let me look that up.',
    })

    expect((await brain.reply(turn())).text).toBe('Let me look that up.')
  })

  it('answers from structured truth even when a script says something else', async () => {
    // A script quoting a price is quoting the price from when the script was
    // written. §17 makes the live value the authorised one, so the script loses.
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { price: 'The suite is 900,000 IDR per night.' },
    })

    const reply = await brain.reply(
      turn({
        utterance: 'what is the price of the suite?',
        structuredTruth: { price: 1_200_000, currency: 'IDR' },
        knowledgeMode: 'structured_truth',
        grounding: [
          { sourceId: 'doc_1', sourceTitle: 'Rates', sourceKind: 'page', text: 'A rate sheet.' },
        ],
      }),
    )

    expect(reply.text).toBe('price: 1200000; currency: IDR')
    // Nothing was retrieved, so nothing is cited: a citation is a claim that a
    // chunk grounded the answer, and on a truth turn no chunk did.
    expect(reply.citations).toEqual([])
    expect(reply.deferToStructuredTruth).toBe(false)
  })

  it('refuses a structured-truth question when no live value resolved', async () => {
    // A price question the live system did not answer is a gap, not an
    // opportunity to reuse whatever chunk happens to be nearby.
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })

    const reply = await brain.reply(
      turn({
        utterance: 'what is the price of the suite?',
        structuredTruth: {},
        knowledgeMode: 'structured_truth',
        grounding: [
          { sourceId: 'doc_1', sourceTitle: 'Rates', sourceKind: 'page', text: 'A rate sheet.' },
        ],
      }),
    )

    expect(reply.deferToStructuredTruth).toBe(true)
    expect(reply.text).not.toContain('rate sheet')
  })

  it('reports healthy without a reason', () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })

    expect(brain.health).toEqual({ ready: true, reason: null })
  })

  it('exposes its own provider id and a model name that is not a credential', () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })

    expect(brain.providerId).toBe('brain-reference')
    expect(brain.model).toBe('deterministic-reference')
  })

  it('never mutates the turn it was handed', async () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { hello: 'hi' },
    })
    const input = turn({ utterance: 'hello', grounding: [] })
    const before = JSON.stringify(input)

    await brain.reply(input)

    expect(JSON.stringify(input)).toBe(before)
  })
})
