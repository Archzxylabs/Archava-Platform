import { describe, expect, it } from 'vitest'
import type { ContextEvent } from '@archava/core'
import {
  isValueBearing,
  maskedFieldNames,
  reconcilePage,
  VALUE_BEARING_FIELD_NAMES,
  type PageShape,
} from '../src/index.js'

/**
 * The translator's contract, in the order it matters:
 *
 * 1. A page the SDK has never seen gets a *full* description, or the graph
 *    would start empty and only partly describe the page it is on.
 * 2. A page it has already seen gets *differences only* — a history that
 *    replayed every mutation could not be replayed as a history.
 * 3. Neither of the above may ever carry a value. Only names.
 */

function page(overrides: Partial<PageShape> = {}): PageShape {
  return {
    path: '/rooms',
    kind: 'catalog',
    locale: 'id',
    entities: [{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }],
    actions: [{ name: 'add_to_cart', enabled: true }],
    errors: [],
    ...overrides,
  }
}

describe('reconcilePage on a first observation', () => {
  it('describes the page rather than reporting nothing changed', () => {
    const events = reconcilePage(null, page())

    // Every axis §16 names that the page reported is present, so a graph folded
    // from these events is not missing a dimension by omission.
    expect(events).toEqual([
      { type: 'page/route', route: '/rooms', kind: 'catalog' },
      { type: 'page/locale', locale: 'id' },
      { type: 'entities/set', entities: [{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }] },
      { type: 'action/set', actions: [{ name: 'add_to_cart', enabled: true }] },
      { type: 'page/activePanel', panel: null },
    ])
  })

  it('emits a section, comparison, and form only when the page has them', () => {
    const events = reconcilePage(
      null,
      page({
        section: 'Deluxe Suites',
        comparison: { entityIds: ['room-1', 'room-2'], metric: 'price' },
        form: {
          id: 'booking',
          completedFields: ['dates'],
          pendingFields: ['guests'],
          maskedFields: [],
        },
      }),
    )

    const types = events.map((event) => event.type)
    expect(types).toContain('page/section')
    expect(types).toContain('comparison/set')
    expect(types).toContain('form/set')
  })

  it('carries the comparison metric through', () => {
    const events = reconcilePage(null, page({ comparison: { entityIds: ['a'], metric: 'price' } }))

    expect(events).toContainEqual({
      type: 'comparison/set',
      entityIds: ['a'],
      metric: 'price',
    })
  })

  it('records the errors the host surfaced, dated as given', () => {
    const events = reconcilePage(
      null,
      page({ errors: [{ code: 'rate_unavailable', occurredAt: '2026-04-01T00:00:00.000Z' }] }),
    )

    expect(events).toContainEqual({
      type: 'error/recorded',
      code: 'rate_unavailable',
      occurredAt: '2026-04-01T00:00:00.000Z',
    })
  })
})

describe('reconcilePage on a page already seen', () => {
  it('reports nothing when nothing changed', () => {
    const before = page()

    // The case worth optimising: a real site fires mutations constantly, and a
    // history that replayed each of them would bury the one that mattered.
    expect(reconcilePage(before, page())).toEqual([])
  })

  it('reports a route change once, with both halves of the move', () => {
    const events = reconcilePage(page(), page({ path: '/checkout', kind: 'checkout' }))

    expect(events).toEqual([{ type: 'page/route', route: '/checkout', kind: 'checkout' }])
  })

  it('reports a section falling away by naming the path it fell back to', () => {
    const events = reconcilePage(page({ section: 'Deluxe' }), page())

    expect(events).toEqual([{ type: 'page/section', section: '/rooms' }])
  })

  it('reports entities, actions, and the active panel changing', () => {
    const events = reconcilePage(
      page(),
      page({
        entities: [{ id: 'room-2', name: 'Standard', kind: 'room' }],
        actions: [{ name: 'add_to_cart', enabled: false }],
        activePanel: 'filters',
      }),
    )

    expect(events).toContainEqual({
      type: 'entities/set',
      entities: [{ id: 'room-2', name: 'Standard', kind: 'room' }],
    })
    // The page's own `enabled` flag travels verbatim; nothing here re-enables a
    // control the page disabled, because §18 lets the gate do that.
    expect(events).toContainEqual({
      type: 'action/set',
      actions: [{ name: 'add_to_cart', enabled: false }],
    })
    expect(events).toContainEqual({ type: 'page/activePanel', panel: 'filters' })
  })

  it('treats a new entity as a change even when the count is the same', () => {
    const events = reconcilePage(
      page(),
      page({ entities: [{ id: 'room-2', name: 'Standard', kind: 'room' }] }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('entities/set')
  })
})

describe('errors across a reconcile', () => {
  it('records only the errors that appeared', () => {
    const first = { code: 'rate_unavailable', occurredAt: '2026-04-01T00:00:00.000Z' }
    const second = { code: 'session_expired', occurredAt: '2026-04-01T00:00:01.000Z' }
    const events = reconcilePage(page({ errors: [first] }), page({ errors: [first, second] }))

    // A history shows one error once; re-recording the standing one would make
    // the log claim a second occurrence that never happened.
    expect(events).toEqual([{ ...second, type: 'error/recorded' }])
  })

  it('clears when the standing errors are gone', () => {
    const first = { code: 'rate_unavailable', occurredAt: '2026-04-01T00:00:00.000Z' }

    expect(reconcilePage(page({ errors: [first] }), page({ errors: [] }))).toEqual([
      { type: 'error/cleared' },
    ])
  })

  it('emits nothing when an error neither appears nor disappears', () => {
    const first = { code: 'rate_unavailable', occurredAt: '2026-04-01T00:00:00.000Z' }

    expect(reconcilePage(page({ errors: [first] }), page({ errors: [{ ...first }] }))).toEqual([])
  })
})

describe('form state across a reconcile', () => {
  it('reports a form appearing and disappearing', () => {
    const form = { id: 'booking', completedFields: ['dates'], pendingFields: [], maskedFields: [] }

    expect(reconcilePage(page(), page({ form })).map((event) => event.type)).toEqual(['form/set'])

    const cleared = reconcilePage(page({ form }), page()).find(
      (event): event is Extract<ContextEvent, { type: 'form/set' }> => event.type === 'form/set',
    )
    expect(cleared?.form).toBeNull()
  })

  it('treats a step change as a form change', () => {
    const before = {
      id: 'booking',
      step: '1',
      completedFields: ['dates'],
      pendingFields: [],
      maskedFields: [],
    }
    const after = { ...before, step: '2' }

    expect(
      reconcilePage(page({ form: before }), page({ form: after })).map((event) => event.type),
    ).toEqual(['form/set'])
  })

  it('carries field names and never a value', () => {
    const events = reconcilePage(
      null,
      page({
        form: {
          id: 'booking',
          completedFields: ['email', 'password'],
          pendingFields: ['guests'],
          maskedFields: [],
        },
      }),
    )

    const form = events.find(
      (event): event is Extract<ContextEvent, { type: 'form/set' }> => event.type === 'form/set',
    )?.form
    expect(form?.completedFields).toEqual(['email', 'password'])
    // The masking boundary is the shape itself: there is nowhere in the payload
    // for a value to be, so there is nothing to forget to drop (§16).
    expect(form?.maskedFields).toEqual(['password'])
    expect(Object.keys(form ?? {})).not.toContain('value')
  })
})

describe('maskedFieldNames', () => {
  it('withholds a value-bearing name the host never labelled', () => {
    // The whole point of the default list: a host that forgot to label its own
    // password field still gets it masked.
    expect(maskedFieldNames(['email', 'password', 'guests'])).toEqual(['password'])
  })

  it('withholds a host-declared name that is not value-bearing by default', () => {
    expect(maskedFieldNames(['nationality'], ['nationality'])).toEqual(['nationality'])
  })

  it('unions the two sources rather than picking one', () => {
    expect(maskedFieldNames(['password', 'nationality', 'email'], ['nationality'])).toEqual([
      'password',
      'nationality',
    ])
  })

  it('leaves ordinary field names alone', () => {
    expect(maskedFieldNames(['first_name', 'last_name'])).toEqual([])
  })
})

describe('isValueBearing', () => {
  it('matches through case and separators', () => {
    // A field called `card-number` is as sensitive as one called `cardNumber`.
    expect(isValueBearing('Password')).toBe(true)
    expect(isValueBearing('card-number')).toBe(true)
    expect(isValueBearing('cvv_confirm')).toBe(true)
  })

  it('does not match an ordinary field', () => {
    expect(isValueBearing('delivery_notes')).toBe(false)
    expect(isValueBearing('email')).toBe(false)
    expect(isValueBearing('guests')).toBe(false)
  })

  it('covers every documented default name', () => {
    expect(VALUE_BEARING_FIELD_NAMES.length).toBeGreaterThan(0)
    for (const name of VALUE_BEARING_FIELD_NAMES) {
      expect(isValueBearing(name)).toBe(true)
    }
  })
})
