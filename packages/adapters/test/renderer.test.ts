import { describe, expect, it } from 'vitest'
import {
  PREFLIGHT_CHECKS,
  preflightPassed,
  preflightRenderer,
  type HumanRenderer,
  type PreflightResult,
} from '../src/index.js'

function pass(check: PreflightResult['check']): PreflightResult {
  return { check, ok: true }
}

describe('preflightRenderer', () => {
  it('carries the provider id and mode through to the selector', () => {
    const preflight = preflightRenderer('renderer-default', 'human', PREFLIGHT_CHECKS.map(pass))

    expect(preflight.providerId).toBe('renderer-default')
    expect(preflight.mode).toBe('human')
    expect(preflightPassed(preflight)).toBe(true)
  })

  it('does not invent a pass for a check the adapter never reported', () => {
    const preflight = preflightRenderer('renderer-default', 'human', [pass('renderer_support')])

    expect(preflightPassed(preflight)).toBe(false)
  })
})

describe('HumanRenderer', () => {
  it('never carries a credential in its session handle', () => {
    const opened: string[] = []
    const spoken: string[] = []
    const closed: string[] = []

    const renderer: HumanRenderer = {
      providerId: 'renderer-default',
      openSession: (request) => {
        opened.push(request.tenantId)
        return { sessionId: 'sess_1', providerId: renderer.providerId }
      },
      speak: (_sessionId, utterance) => {
        spoken.push(utterance.transcript)
      },
      close: (sessionId) => {
        closed.push(sessionId)
      },
    }

    const session = renderer.openSession({
      tenantId: 'tenant-acme',
      locale: 'id',
      personaName: 'Ava',
    })
    renderer.speak(session.sessionId, { transcript: 'Halo!', spoken: 'Halo!' })
    renderer.close(session.sessionId)

    expect(opened).toEqual(['tenant-acme'])
    expect(spoken).toEqual(['Halo!'])
    expect(closed).toEqual(['sess_1'])
    // §24: the handle the caller holds is an id, not a token.
    expect(Object.keys(session)).toEqual(['sessionId', 'providerId'])
  })
})
