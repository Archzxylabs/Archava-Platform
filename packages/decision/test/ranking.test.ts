import { describe, expect, it } from 'vitest'
import { rankScoredOptions } from '../src/index.js'

describe('closed ranked-option primitive', () => {
  it('ranks only already-valid candidates with deterministic ties', () => {
    expect(
      rankScoredOptions(
        ['a', 'b', 'c'],
        [
          { id: 'c', score: 0.7, confidence: 0.8 },
          { id: 'b', score: 0.9, confidence: 0.8 },
          { id: 'a', score: 0.9, confidence: 0.8 },
        ],
      )?.map((item) => item.id),
    ).toEqual(['a', 'b', 'c'])
  })

  it('rejects invented, duplicated, missing, or unbounded scores', () => {
    const good = [{ id: 'a', score: 0.7, confidence: 0.8 }]
    expect(rankScoredOptions(['a'], [{ id: 'invented', score: 1, confidence: 1 }])).toBeNull()
    expect(rankScoredOptions(['a', 'b'], good)).toBeNull()
    expect(rankScoredOptions(['a', 'a'], good)).toBeNull()
    expect(rankScoredOptions(['a'], [{ id: 'a', score: 2, confidence: 1 }])).toBeNull()
  })
})
