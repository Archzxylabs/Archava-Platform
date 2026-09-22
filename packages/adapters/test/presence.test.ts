import { describe, expect, it } from 'vitest'
import {
  PREFLIGHT_CHECKS,
  PRESENCE_FALLBACK_ORDER,
  PRESENCE_MODES,
  preflightFailures,
  preflightPassed,
  selectPresence,
  type EmbodimentPreflight,
  type PreflightResult,
} from '../src/index.js'

function pass(check: PreflightResult['check']): PreflightResult {
  return { check, ok: true }
}

function preflight(
  providerId: string,
  mode: 'human' | 'voice',
  results: readonly PreflightResult[],
): EmbodimentPreflight {
  return { providerId, mode, results }
}

const healthyHuman = preflight('renderer-default', 'human', PREFLIGHT_CHECKS.map(pass))

describe('preflightPassed', () => {
  it('passes when every check reported ok', () => {
    expect(preflightPassed(healthyHuman)).toBe(true)
    expect(preflightFailures(healthyHuman)).toEqual([])
  })

  it('treats an unreported check as a failure, not an absence', () => {
    // "Not measured" and "measured fine" are different facts, and only one of
    // them is safe.
    const partial = preflight('renderer-default', 'human', [
      pass('renderer_support'),
      pass('network_reachability'),
    ])

    expect(preflightPassed(partial)).toBe(false)
    expect(preflightFailures(partial).map((failure) => failure.check)).toEqual([
      'session_bootstrap',
      'performance_readiness',
    ])
  })

  it('carries the detail a failing check reported', () => {
    const weak = preflight('renderer-default', 'human', [
      pass('renderer_support'),
      pass('network_reachability'),
      pass('session_bootstrap'),
      { check: 'performance_readiness', ok: false, detail: 'frame budget 41ms exceeds 16ms' },
    ])

    expect(preflightPassed(weak)).toBe(false)
    expect(preflightFailures(weak)).toEqual([
      { check: 'performance_readiness', ok: false, detail: 'frame budget 41ms exceeds 16ms' },
    ])
  })
})

describe('selectPresence', () => {
  it('uses the requested mode when its preflight passes', () => {
    const selection = selectPresence('human', [healthyHuman])

    expect(selection.mode).toBe('human')
    expect(selection.providerId).toBe('renderer-default')
    expect(selection.fellBack).toBe(false)
    expect(selection.skipped).toEqual([])
  })

  it('falls back to chat when human has no embodiment installed', () => {
    const selection = selectPresence('human', [])

    // Chat is the floor: no transport, no renderer. This is what makes "Archava
    // must remain usable" true by construction rather than by a provider's uptime.
    expect(selection.mode).toBe('chat')
    expect(selection.providerId).toBeNull()
    expect(selection.fellBack).toBe(true)
    expect(selection.skipped).toEqual([
      { mode: 'human', reason: 'no human embodiment is installed' },
      { mode: 'voice', reason: 'no voice embodiment is installed' },
    ])
    expect(selection.reason).toBe(
      'fell back to chat; human (no human embodiment is installed), voice (no voice embodiment is installed)',
    )
  })

  it('falls back to voice before chat', () => {
    const voice = preflight('voice-transport', 'voice', PREFLIGHT_CHECKS.map(pass))
    const selection = selectPresence('human', [voice])

    expect(selection.mode).toBe('voice')
    expect(selection.providerId).toBe('voice-transport')
    expect(selection.fellBack).toBe(true)
    expect(selection.skipped[0]?.mode).toBe('human')
  })

  it('reports which checks disqualified the requested mode', () => {
    const broken = preflight('renderer-default', 'human', [
      { check: 'renderer_support', ok: false, detail: 'WebGL unavailable' },
      { check: 'network_reachability', ok: false, detail: 'relay unreachable' },
      pass('session_bootstrap'),
      pass('performance_readiness'),
    ])
    const selection = selectPresence('human', [broken])

    expect(selection.mode).toBe('chat')
    expect(selection.reason).toContain('WebGL unavailable')
    expect(selection.reason).toContain('relay unreachable')
  })

  it('skips an embodiment that failed and tries the next candidate', () => {
    const first = preflight('renderer-primary', 'human', [
      { check: 'performance_readiness', ok: false, detail: 'low-end device' },
      ...PREFLIGHT_CHECKS.filter((check) => check !== 'performance_readiness').map(pass),
    ])
    const second = preflight('renderer-secondary', 'human', PREFLIGHT_CHECKS.map(pass))

    const selection = selectPresence('human', [first, second])

    expect(selection.mode).toBe('human')
    expect(selection.providerId).toBe('renderer-secondary')
    expect(selection.skipped).toEqual([{ mode: 'human', reason: 'low-end device' }])
  })

  it('gives chat for free when it is the requested mode', () => {
    const selection = selectPresence('chat', [healthyHuman])

    expect(selection.mode).toBe('chat')
    expect(selection.providerId).toBeNull()
    expect(selection.fellBack).toBe(false)
    expect(selection.reason).toBe('chat requested and always available')
  })

  it('never falls back upward', () => {
    const voice = preflight('voice-transport', 'voice', PREFLIGHT_CHECKS.map(pass))
    const human = preflight('renderer-default', 'human', PREFLIGHT_CHECKS.map(pass))

    // Voice requested, human healthy: richness does not override the tenant's
    // configured mode.
    expect(selectPresence('voice', [voice, human]).mode).toBe('voice')
  })

  it('lands on chat when the requested and every richer mode fail', () => {
    const brokenVoice = preflight('voice-transport', 'voice', [
      { check: 'network_reachability', ok: false, detail: 'offline' },
      ...PREFLIGHT_CHECKS.filter((check) => check !== 'network_reachability').map(pass),
    ])
    const selection = selectPresence('voice', [brokenVoice])

    expect(selection.mode).toBe('chat')
    expect(selection.skipped.map((entry) => entry.mode)).toEqual(['voice', 'human'])
  })

  it('always ends on a mode from the published order', () => {
    for (const requested of PRESENCE_MODES) {
      const selection = selectPresence(requested, [healthyHuman])
      expect([requested, ...PRESENCE_FALLBACK_ORDER]).toContain(selection.mode)
    }
  })
})
