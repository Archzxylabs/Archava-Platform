import { describe, expect, it } from 'vitest'
import { ScriptedBrain, type BrainTurn } from '../src/index.js'

function turn(overrides: Partial<BrainTurn> = {}): BrainTurn {
  return {
    tenantId: 'tenant-acme',
    utterance: 'What is your return policy?',
    locale: 'en',
    context: {},
    grounding: [],
    permittedActionIds: [],
    ...overrides,
  }
}

describe('ScriptedBrain', () => {
  it('answers an exact scripted match', () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { 'return policy': 'You have 30 days.' },
    })

    const reply = brain.reply(turn({ utterance: 'What is your return policy?' }))

    expect(reply.text).toBe('You have 30 days.')
    expect(reply.deferToStructuredTruth).toBe(false)
    expect(reply.requestedActions).toEqual([])
  })

  it('matches case-insensitively on a substring', () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { 'return policy': 'You have 30 days.' },
    })

    expect(brain.reply(turn({ utterance: 'tell me about the RETURN POLICY please' })).text).toBe(
      'You have 30 days.',
    )
  })

  it('answers from authored knowledge when no script matches', () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })
    const reply = brain.reply(
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

  it('cites every chunk it was handed, not just the one it read', () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })
    const reply = brain.reply(
      turn({
        grounding: [
          { sourceId: 'doc_1', sourceTitle: 'Shipping', sourceKind: 'faq', text: 'a' },
          { sourceId: 'doc_2', sourceTitle: 'Returns', sourceKind: 'policy', text: 'b' },
        ],
      }),
    )

    expect(reply.citations.map((citation) => citation.sourceId)).toEqual(['doc_1', 'doc_2'])
  })

  it('declines rather than inventing an answer', () => {
    const brain = new ScriptedBrain({ providerId: 'brain-reference' })

    const reply = brain.reply(turn({ utterance: 'where is my order' }))

    expect(reply.deferToStructuredTruth).toBe(true)
    expect(reply.citations).toEqual([])
    expect(reply.text).not.toHaveLength(0)
  })

  it('honours an explicit fallback', () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      fallback: 'Let me look that up.',
    })

    expect(brain.reply(turn()).text).toBe('Let me look that up.')
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

  it('never mutates the turn it was handed', () => {
    const brain = new ScriptedBrain({
      providerId: 'brain-reference',
      answers: { hello: 'hi' },
    })
    const input = turn({ utterance: 'hello', grounding: [] })
    const before = JSON.stringify(input)

    brain.reply(input)

    expect(JSON.stringify(input)).toBe(before)
  })
})
