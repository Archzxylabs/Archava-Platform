import { describe, expect, it } from 'vitest'
import {
  activeLeads,
  approveFollowUp,
  createDemo,
  pipelineValue,
  restoreDemo,
} from '../src/frontend/data.js'

describe('frontend demo persistence and proposals', () => {
  it('restores user edits without replacing them with the seed', () => {
    const state = createDemo('studio')
    const lead = state.leads[0]
    if (lead === undefined) throw new Error('Missing seed lead')
    lead.name = 'Demo edit'
    const saved: unknown = JSON.parse(JSON.stringify(state))
    expect(restoreDemo(saved, 'studio').leads[0]?.name).toBe('Demo edit')
  })

  it('rejects corrupt records rather than crashing or calculating invalid amounts', () => {
    const seed = createDemo('studio')
    const corrupt = { ...seed, orders: [{ ...seed.orders[0], status: { toString: null } }] }
    expect(() => restoreDemo(corrupt, 'studio')).not.toThrow()
    expect(restoreDemo(corrupt, 'studio').orders[0]?.status).toBe('Ready')
    const badAmount = { ...seed, leads: [{ ...seed.leads[0], value: -10 }] }
    expect(pipelineValue(restoreDemo(badAmount, 'studio'))).toBe(148000000)
  })

  it('rejects duplicate lead IDs and orphaned task references', () => {
    const state = createDemo('studio')
    expect(
      restoreDemo({ ...state, leads: [state.leads[0], state.leads[0]] }, 'studio').leads,
    ).toHaveLength(8)
    const orphan = { ...state, tasks: [{ ...state.tasks[0], leadId: 'missing-record' }] }
    expect(restoreDemo(orphan, 'studio').tasks[0]?.leadId).toBe('lead-1')
  })

  it('starts the selected industry when a stored schema is unsupported', () => {
    const state = restoreDemo({ version: 99 }, 'healthcare')
    expect(state.leads[0]?.company).toContain('Care Clinic')
    expect(state.leads[0]?.interest).toContain('Service enquiry')
  })

  it('creates one approved task per record, including after a reload', () => {
    const state = createDemo('studio')
    expect(approveFollowUp(state, 'lead-4')).toBe(true)
    expect(state.tasks).toHaveLength(5)
    const saved: unknown = JSON.parse(JSON.stringify(state))
    const restored = restoreDemo(saved, 'studio')
    expect(approveFollowUp(restored, 'lead-4')).toBe(false)
    expect(restored.tasks).toHaveLength(5)
    expect(restored.activity.filter((item) => item.message.includes('approved'))).toHaveLength(1)
  })

  it('does not create a task for an unknown record', () => {
    const state = createDemo('studio')
    expect(approveFollowUp(state, 'nonexistent')).toBe(false)
    expect(state.tasks).toHaveLength(4)
  })

  it('excludes won and lost records from the open pipeline total', () => {
    const state = createDemo('studio')
    const lead = state.leads[3]
    if (lead === undefined) throw new Error('Missing seed lead')
    lead.stage = 'won'
    expect(activeLeads(state)).toHaveLength(7)
    expect(pipelineValue(state)).toBe(124000000)
    lead.stage = 'lost'
    expect(pipelineValue(state)).toBe(124000000)
  })
})
