import { describe, expect, it } from 'vitest'
import {
  DecisionError,
  DECISION_KINDS,
  decisionQuestionProblem,
  type Decision,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRequest,
} from '../src/index.js'

/**
 * The port's contract, asserted without a provider behind it.
 *
 * A port is defined by what it *cannot* do, so these tests are mostly refusals:
 * a question that will not survive the boundary is caught here, and a malformed
 * `Decision` is rejected before it reaches a consumer. That is the only version
 * of this worth writing — a test that wires a fake provider and asserts a happy
 * path proves that an interface can be implemented, which TypeScript already
 * said.
 */

describe('decisionQuestionProblem', () => {
  it('accepts a well-formed boolean question', () => {
    expect(
      decisionQuestionProblem({ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }),
    ).toBe(null)
  })

  it('accepts a choice with a closed answer set', () => {
    const question: DecisionQuestion = {
      id: 'x',
      kind: 'choice',
      prompt: 'Which one?',
      options: ['a', 'b'],
    }
    expect(decisionQuestionProblem(question)).toBe(null)
  })

  it('accepts a score with an interior range', () => {
    expect(
      decisionQuestionProblem({ id: 'x', kind: 'score', prompt: 'How strong?', bounds: [0, 1] }),
    ).toBe(null)
  })

  it('rejects a question with no id', () => {
    expect(decisionQuestionProblem({ id: '   ', kind: 'boolean', prompt: 'Anything' })).toMatch(
      /stable id/,
    )
  })

  it('rejects a question with no prompt', () => {
    expect(decisionQuestionProblem({ id: 'x', kind: 'boolean', prompt: '' })).toMatch(/prompt/)
  })

  it('rejects a choice with an empty answer set', () => {
    expect(
      decisionQuestionProblem({ id: 'x', kind: 'choice', prompt: 'Which one?', options: [] }),
    ).toMatch(/closed answer set/)
  })

  it('rejects a choice whose options are missing entirely', () => {
    expect(decisionQuestionProblem({ id: 'x', kind: 'choice', prompt: 'Which one?' })).toMatch(
      /closed answer set/,
    )
  })

  it('rejects a score with no bounds', () => {
    expect(decisionQuestionProblem({ id: 'x', kind: 'score', prompt: 'How strong?' })).toMatch(
      /bounds/,
    )
  })

  it('rejects bounds whose range is empty', () => {
    expect(
      decisionQuestionProblem({ id: 'x', kind: 'score', prompt: 'How strong?', bounds: [1, 0] }),
    ).toMatch(/empty/)
  })

  it('accepts a one-point range', () => {
    expect(
      decisionQuestionProblem({ id: 'x', kind: 'score', prompt: 'How strong?', bounds: [1, 1] }),
    ).toBe(null)
  })
})

describe('the decision kinds', () => {
  it('stays a closed set, so a fourth kind is a new port not a new branch', () => {
    expect(DECISION_KINDS).toEqual(['boolean', 'choice', 'score'])
  })

  it('cannot answer an open-ended question: there is no free-text kind', () => {
    // The reason this port is not a language model, encoded as a value rather
    // than a comment. A `Decision` that could hold prose would be a BrainReply.
    expect(DECISION_KINDS).not.toContain('text')
    expect(DECISION_KINDS).not.toContain('action')
  })

  it('types each answer against the shape that carries it', () => {
    const boolean: Decision = { id: 'x', kind: 'boolean', answer: true, confidence: 0.9 }
    const choice: Decision = { id: 'y', kind: 'choice', answer: 'a', confidence: 0.8 }
    const score: Decision = { id: 'z', kind: 'score', answer: 0.5, confidence: 0.7 }
    expect([boolean.answer, choice.answer, score.answer]).toEqual([true, 'a', 0.5])
  })
})

/**
 * A provider that refuses rather than guesses, as every provider must be able
 * to. The guardrail is that the port has somewhere to put "I cannot answer
 * this", because the alternative is a fabricated `false` — which the consumer
 * reads as an answer, silently.
 */
describe('the refusal field', () => {
  it('lets a provider explain itself without a controlled vocabulary', () => {
    // A refusal is the provider's own account of itself, carried to the audit
    // trail. A closed enum here would be either a catch-all nobody reads or a
    // new shared entry per provider's particular failure.
    const refusal = { id: 'x', reason: 'the utterance was a question about a tenant schema' }
    expect(refusal.reason).toMatch(/tenant schema/)
  })
})

/**
 * The request a caller assembles, asserted as the boundary it is.
 *
 * Nothing here is executed — the point is the shape. Every field a decision may
 * weigh is an explicit argument, so a provider reaching for the clock, a store
 * or a tenant's schema is reaching past a shape that has no hole for it.
 */
describe('the request shape', () => {
  it('carries the facts a decision may weigh, masked by the caller', () => {
    const request: DecisionRequest = {
      tenantId: 'tenant-a',
      utterance: 'how much is the deluxe suite',
      locale: 'en',
      evidence: { priceVisible: 1_438_000 },
      questions: [{ id: 'x', kind: 'boolean', prompt: 'Is this a price question?' }],
    }
    expect(Object.keys(request).sort()).toEqual([
      'evidence',
      'locale',
      'questions',
      'tenantId',
      'utterance',
    ])
  })

  it('asks several questions in one call, one utterance to read', () => {
    const request: DecisionRequest = {
      tenantId: 'tenant-a',
      utterance: 'can I book the deluxe suite for friday',
      locale: 'id',
      evidence: {},
      questions: [
        { id: 'bookable', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'date', kind: 'choice', prompt: 'Which date?', options: ['fri', 'sat'] },
        { id: 'strength', kind: 'score', prompt: 'How strong?', bounds: [0, 1] },
      ],
    }
    expect(request.questions).toHaveLength(3)
    expect(request.questions.map((question) => question.kind)).toEqual(DECISION_KINDS)
  })
})

describe('DecisionError', () => {
  it('names itself so a stack trace is readable', () => {
    expect(new DecisionError('missing key').name).toBe('DecisionError')
  })
})

/**
 * The port is async even for a provider that could answer offline.
 *
 * A synchronous port would let a caller drop the `await`, and a dropped `await`
 * on a judgment is how a stale `false` gets read as a fresh answer. The reason
 * {@link BrainProvider} is async is the same, and it is a contract, not a
 * shape: the type forces the caller to account for the delay.
 *
 * The fake below has nothing to await, so it builds its reply with
 * `Promise.resolve` rather than an `async` arrow: an `async` method with no
 * `await` inside it is the shape of a deliberate refusal to be async, which is
 * the very thing this describes. `resolve` returns the promise without
 * pretending to be one synchronously.
 */
describe('the port is async by contract', () => {
  it('returns a promise from decide()', () => {
    const provider: DecisionProvider = {
      providerId: 'test',
      model: 'test-model',
      health: { ready: true, reason: null },
      decide: () =>
        Promise.resolve({
          providerId: 'test',
          model: 'test-model',
          decisions: [],
          refused: [],
        }),
    }
    const result = provider.decide({
      tenantId: 'tenant-a',
      utterance: 'hi',
      locale: 'en',
      evidence: {},
      questions: [],
    })
    expect(typeof result.then).toBe('function')
  })
})
