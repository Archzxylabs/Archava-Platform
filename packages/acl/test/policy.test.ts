import { describe, expect, it } from 'vitest'
import {
  ACTION_REGISTRY_VERSION,
  ActionRegistry,
  ActionRegistryError,
  BASELINE_ACTIONS,
  satisfiesCapability,
  ActionPolicy,
} from '../src/index.js'

const BASE = {
  actionId: 'booking.create',
  capability: 'act',
  role: 'archava_assistant',
} as const

describe('ActionRegistry', () => {
  it('is versioned', () => {
    expect(ACTION_REGISTRY_VERSION).toBe('1.0.0')
    expect(new ActionRegistry().version).toBe('1.0.0')
  })

  it('gives every action the PRD 18 required fields', () => {
    for (const action of BASELINE_ACTIONS) {
      expect(action.id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
      expect(action.level).toMatch(/^L[0-5]$/)
      expect(action.description.length).toBeGreaterThan(0)
      // A declared field may legitimately be empty — `checkout.start` reads the
      // cart and `admin.knowledge.reindex` takes nothing. PRD §18 asks that the
      // field be *declared*, not populated.
      expect(action.requiredInputs).toBeInstanceOf(Array)
      expect(action.allowedRoles.length).toBeGreaterThan(0)
      expect(typeof action.idempotent).toBe('boolean')
      expect(typeof action.audited).toBe('boolean')
      expect(action.sensitiveFields).toBeInstanceOf(Array)
    }
  })

  it('never reuses an action id', () => {
    const ids = BASELINE_ACTIONS.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('throws on an unregistered id rather than returning undefined', () => {
    expect(() => new ActionRegistry().get('booking.cancel_with_refund')).toThrow(
      ActionRegistryError,
    )
    expect(new ActionRegistry().tryGet('nope')).toBeUndefined()
  })

  it('keeps deprecated actions resolvable so old client contracts keep working', () => {
    const registry = new ActionRegistry()
    expect(registry.has('lead.capture')).toBe(true)
    expect(registry.deprecations()).toEqual([])
  })

  it('declares confirmation for every L3+ action', () => {
    for (const action of BASELINE_ACTIONS) {
      if (action.level === 'L0' || action.level === 'L1' || action.level === 'L2') continue
      expect(action.confirmation).not.toBe('none')
    }
  })
})

describe('capability ordering', () => {
  it('is monotonic', () => {
    expect(satisfiesCapability('assist', 'assist')).toBe(true)
    expect(satisfiesCapability('act', 'assist')).toBe(true)
    expect(satisfiesCapability('transact', 'act')).toBe(true)
    expect(satisfiesCapability('enterprise', 'transact')).toBe(true)

    expect(satisfiesCapability('assist', 'act')).toBe(false)
    expect(satisfiesCapability('act', 'transact')).toBe(false)
    expect(satisfiesCapability('transact', 'enterprise')).toBe(false)
  })
})

describe('ActionPolicy', () => {
  const policy = new ActionPolicy()

  it('fails closed on an unknown action', () => {
    const result = policy.evaluate({
      actionId: 'payment.capture_all_money',
      capability: 'transact',
      role: 'archava_assistant',
    })
    expect(result.decision).toBe('denied')
    if (result.decision !== 'denied') throw new Error('expected denial')
    expect(result.reason).toBe('unknown_action')
    expect(result.action).toBeNull()
  })

  it('fails closed when the role may not act', () => {
    const result = policy.evaluate({ ...BASE, role: 'viewer' })
    expect(result.decision).toBe('denied')
    if (result.decision !== 'denied') throw new Error('expected denial')
    expect(result.reason).toBe('role_not_allowed')
  })

  it('fails closed when the capability is below the requirement', () => {
    const result = policy.evaluate({ ...BASE, capability: 'assist' })
    expect(result.decision).toBe('denied')
    if (result.decision !== 'denied') throw new Error('expected denial')
    expect(result.reason).toBe('capability_insufficient')
  })

  it('requires user confirmation for L3, even at the exact capability', () => {
    const unconfirmed = policy.evaluate({ ...BASE })
    expect(unconfirmed.decision).toBe('confirmation_required')
    if (unconfirmed.decision !== 'confirmation_required') throw new Error('expected prompt')
    expect(unconfirmed.mode).toBe('user_confirm')
    expect(unconfirmed.prompt).toContain('confirmation')

    const confirmed = policy.evaluate({ ...BASE, confirmed: true })
    expect(confirmed.decision).toBe('allow')
  })

  it('never lets capability override the L4 confirmation rule (PRD 18)', () => {
    // A Transact client still has to confirm a payment action.
    const result = policy.evaluate({
      actionId: 'payment.initiate',
      capability: 'transact',
      role: 'archava_assistant',
    })
    expect(result.decision).toBe('confirmation_required')
    if (result.decision !== 'confirmation_required') throw new Error('expected prompt')
    expect(result.mode).toBe('user_confirm')
  })

  it('never runs an L5 action autonomously, even with the enterprise tier', () => {
    const result = policy.evaluate({
      actionId: 'admin.config.update',
      capability: 'enterprise',
      role: 'owner',
    })
    expect(result.decision).toBe('denied')
    if (result.decision !== 'denied') throw new Error('expected denial')
    expect(result.reason).toBe('admin_action_requires_human')
  })

  it('never hands an L5 action to a non-admin role', () => {
    const result = policy.evaluate({
      actionId: 'admin.knowledge.reindex',
      capability: 'enterprise',
      role: 'viewer',
      humanApproved: true,
    })
    expect(result.decision).toBe('denied')
    if (result.decision !== 'denied') throw new Error('expected denial')
    expect(result.reason).toBe('role_not_allowed')
  })

  it('honours a per-client action allow-list', () => {
    const result = policy.evaluate({ ...BASE, enabledActionIds: ['lead.capture'] })
    expect(result.decision).toBe('denied')
    if (result.decision !== 'denied') throw new Error('expected denial')
    expect(result.reason).toBe('action_disabled_for_client')
  })

  it('lets the page context remove an action but never add one', () => {
    const withPage = policy.evaluate({ ...BASE, availableOnPage: true, confirmed: true })
    expect(withPage.decision).toBe('allow')

    const withoutPage = policy.evaluate({ ...BASE, availableOnPage: false, confirmed: true })
    expect(withoutPage.decision).toBe('denied')
    if (withoutPage.decision !== 'denied') throw new Error('expected denial')
    expect(withoutPage.reason).toBe('action_unavailable_on_page')
  })

  it('exposes only permitted actions to the model', () => {
    const assist = policy.availableActionIds({
      capability: 'assist',
      role: 'archava_assistant',
    })
    expect(assist).toContain('lead.capture')
    expect(assist).toContain('handoff.request')
    expect(assist).not.toContain('booking.create')

    const act = policy.availableActionIds({ capability: 'act', role: 'archava_assistant' })
    expect(act).toContain('booking.create')
    expect(act).not.toContain('payment.initiate')

    const transact = policy.availableActionIds({
      capability: 'transact',
      role: 'archava_assistant',
    })
    expect(transact).toContain('payment.initiate')
    expect(transact).not.toContain('admin.config.update')
  })

  it('keeps the assistant out of every admin action', () => {
    const all = policy.availableActionIds({
      capability: 'enterprise',
      role: 'archava_assistant',
    })
    for (const action of BASELINE_ACTIONS) {
      if (action.level !== 'L5') continue
      expect(all).not.toContain(action.id)
    }
  })
})
