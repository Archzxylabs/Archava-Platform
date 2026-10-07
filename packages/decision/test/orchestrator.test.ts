import { describe, expect, it } from 'vitest'
import type { DecisionProvider, DecisionRequest, DecisionResult } from '@archava/adapters'
import { JevDecisionProvider } from '@archava/adapters/server'
import { DecisionOrchestrator, RuleDecisionProvider, type DecisionBaseline } from '../src/index.js'

const turn = {
  tenantId: 'tenant-a',
  utterance: 'Is my booking confirmed?',
  locale: 'en',
  evidence: {},
}
const routing: DecisionBaseline = {
  task: 'knowledge_routing',
  answer: 'structured_truth',
  source: 'foundation',
}

function provider(
  answer: 'retrieval_knowledge' | 'structured_truth',
  confidence = 1,
): DecisionProvider & { calls: number } {
  let calls = 0
  return {
    providerId: 'mock',
    model: 'bounded-v1',
    health: { ready: true },
    get calls() {
      return calls
    },
    decide(request: DecisionRequest): Promise<DecisionResult> {
      calls += 1
      return Promise.resolve({
        providerId: 'mock',
        model: 'bounded-v1',
        decisions: request.questions.map((question) => ({
          id: question.id,
          kind: 'choice' as const,
          answer,
          confidence,
        })),
        refused: [],
      })
    },
  }
}

describe('DecisionOrchestrator safety', () => {
  it('off never calls a provider', async () => {
    const mock = provider('retrieval_knowledge')
    const run = await new DecisionOrchestrator({ mode: 'off', provider: mock }).run(turn, [routing])
    expect(mock.calls).toBe(0)
    expect(run.decisions[0]?.answer).toBe('structured_truth')
    expect(run.traces[0]?.outcome).toBe('not_called')
  })

  it('shadow records disagreement without changing routing', async () => {
    const run = await new DecisionOrchestrator({
      mode: 'shadow',
      provider: provider('retrieval_knowledge'),
      enabledTasks: ['knowledge_routing'],
    }).run(turn, [routing])
    expect(run.decisions[0]?.answer).toBe('structured_truth')
    expect(run.traces[0]).toMatchObject({
      agreement: 'downgraded',
      applied: false,
      wouldApply: false,
    })
  })

  it('assist cannot downgrade structured truth even at confidence 1', async () => {
    const run = await new DecisionOrchestrator({
      mode: 'assist',
      provider: provider('retrieval_knowledge'),
      enabledTasks: ['knowledge_routing'],
    }).run(turn, [routing])
    expect(run.decisions[0]).toMatchObject({ answer: 'structured_truth', source: 'baseline' })
    expect(run.traces[0]?.applied).toBe(false)
  })

  it('assist may escalate retrieval, subject to a per-tenant floor', async () => {
    const baseline: DecisionBaseline = {
      task: 'knowledge_routing',
      answer: 'retrieval_knowledge',
      source: 'foundation',
    }
    const low = await new DecisionOrchestrator({
      mode: 'assist',
      provider: provider('structured_truth', 0.8),
      enabledTasks: ['knowledge_routing'],
      minimumConfidence: { knowledge_routing: 0.9 },
    }).run(turn, [baseline])
    expect(low.decisions[0]?.source).toBe('baseline')
    const high = await new DecisionOrchestrator({
      mode: 'assist',
      provider: provider('structured_truth', 0.9),
      enabledTasks: ['knowledge_routing'],
      minimumConfidence: { knowledge_routing: 0.9 },
    }).run(turn, [baseline])
    expect(high.decisions[0]).toMatchObject({ answer: 'structured_truth', source: 'provider' })
  })

  it('malformed and failed providers return the baseline without exposing errors', async () => {
    const malformed: DecisionProvider = {
      providerId: 'mock',
      model: 'bounded-v1',
      health: { ready: true },
      decide: () =>
        Promise.resolve({ providerId: 'mock', model: 'wrong', decisions: [], refused: [] }),
    }
    const failed: DecisionProvider = {
      providerId: 'mock',
      model: 'bounded-v1',
      health: { ready: true },
      decide: () => Promise.reject(new Error('secret customer payload')),
    }
    const synchronousFailure: DecisionProvider = {
      providerId: 'mock',
      model: 'bounded-v1',
      health: { ready: true },
      decide: () => {
        throw new Error('secret customer payload')
      },
    }
    for (const candidate of [malformed, failed, synchronousFailure]) {
      const run = await new DecisionOrchestrator({
        mode: 'assist',
        provider: candidate,
        enabledTasks: ['knowledge_routing'],
      }).run(turn, [routing])
      expect(run.decisions[0]?.answer).toBe('structured_truth')
      expect(JSON.stringify(run.traces)).not.toContain('secret customer payload')
    }
  })

  it('times out and returns the baseline', async () => {
    const stalled: DecisionProvider = {
      providerId: 'mock',
      model: 'bounded-v1',
      health: { ready: true },
      decide: () => new Promise(() => undefined),
    }
    const run = await new DecisionOrchestrator({
      mode: 'assist',
      provider: stalled,
      enabledTasks: ['knowledge_routing'],
      timeoutMs: 5,
    }).run(turn, [routing])
    expect(run.traces[0]?.outcome).toBe('timeout')
    expect(run.decisions[0]?.source).toBe('baseline')
  })

  it('the offline provider can answer boolean tasks in their actual type', async () => {
    const rule = new RuleDecisionProvider()
    const result = await rule.decide({
      ...turn,
      utterance: 'I need to talk to a real person and staff',
      questions: [{ id: 'handoff_recommendation', kind: 'boolean', prompt: 'handoff?' }],
    })
    expect(result.decisions[0]).toMatchObject({ kind: 'boolean', answer: true })
  })

  it('accepts Jev resolved-version responses through its configured alias identity', async () => {
    const jev = new JevDecisionProvider({
      apiKey: 'fake-test-key',
      transport: {
        post: () =>
          Promise.resolve({
            status: 200,
            body: JSON.stringify({
              model: 'jev-1.13.0',
              answers: {
                knowledge_routing: {
                  type: 'choice',
                  choice: 'structured_truth',
                  confidence: 0.95,
                  probabilities: { retrieval_knowledge: 0.05, structured_truth: 0.95 },
                },
              },
            }),
          }),
      },
    })
    const baseline: DecisionBaseline = {
      task: 'knowledge_routing',
      answer: 'retrieval_knowledge',
      source: 'foundation',
    }
    const run = await new DecisionOrchestrator({
      mode: 'assist',
      provider: jev,
      enabledTasks: ['knowledge_routing'],
    }).run(turn, [baseline])
    expect(run.decisions[0]).toMatchObject({ answer: 'structured_truth', source: 'provider' })
    expect(run.traces[0]?.model).toBe('jev-latest')
  })
})
