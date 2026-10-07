import { describe, expect, it } from 'vitest'
import { parseClientConfig } from '@archava/config'
import { referenceConfig } from '@archava/reference'
import { createSlice } from '../src/slice.js'

const at = '2026-09-27T00:00:00.000Z'

function decisionSlice(mode: 'off' | 'shadow' | 'assist', provider = 'rule-baseline') {
  return createSlice(
    parseClientConfig({
      ...referenceConfig,
      decision: {
        mode,
        provider,
        tasks: { handoff_recommendation: { enabled: true, minConfidence: 0.55 } },
      },
    }),
  )
}

async function ask(mode: 'off' | 'shadow' | 'assist', provider?: string) {
  const slice = decisionSlice(mode, provider)
  return slice.ask({
    utterance: 'I need a real person, human staff or manager',
    graph: slice.seed('/'),
    sessionId: 'offline-test',
    occurredAt: at,
  })
}

describe('offline reference Decision Intelligence', () => {
  it('off and shadow keep the visible answer while shadow records a candidate', async () => {
    const off = await ask('off')
    const shadow = await ask('shadow')
    expect(shadow.text).toBe(off.text)
    expect(shadow.basis).toBe(off.basis)
    expect(shadow.handoff).toEqual(off.handoff)
    expect(shadow.decision?.traces[0]).toMatchObject({
      mode: 'shadow',
      applied: false,
      outcome: 'answered',
    })
  })

  it('assist can recommend handoff with the offline Rule provider', async () => {
    const assist = await ask('assist')
    expect(assist.handoff?.reason).toBe('decision_recommended')
    expect(assist.decision?.traces[0]).toMatchObject({ applied: true, runtimeChanged: true })
  })

  it('a server-only provider named in browser config falls back safely', async () => {
    const outcome = await ask('assist', 'typesafe-jev')
    expect(outcome.decision?.traces[0]?.outcome).toBe('failed')
    expect(outcome.handoff).toBeNull()
  })
})
