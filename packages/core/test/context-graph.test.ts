import { describe, expect, it } from 'vitest'
import { parseClientConfig, type ClientConfig } from '@archava/config'
import {
  actionableContext,
  foldContextEvents,
  parseContextGraph,
  reduceContextGraph,
  seedContextGraph,
  type ContextGraph,
  type ContextEvent,
} from '../src/index.js'

/**
 * The fixture is built through the real parser rather than cast into shape: if
 * the config schema changes, this test should fail on the fixture instead of
 * quietly testing a config the platform would never accept.
 */
function configFor(tenantId = 'acme-hotels'): ClientConfig {
  return parseClientConfig({
    schema_version: '1.0.0',
    tenantId,
    environment: 'commerce_booking',
    presence: 'chat',
    capability: 'transact',
    region: 'ID',
    template: 'hospitality',
    branding: {
      businessName: 'Acme Hotels',
      theme: {
        accent: '#123456',
        surface: '#ffffff',
        ink: '#101010',
        radius: 'rounded',
        fontFamily: 'Inter',
      },
    },
    languages: [{ code: 'id', label: 'Bahasa Indonesia' }],
    primaryLanguage: 'id',
    updatedAt: '2026-04-01',
  })
}

function seeded(route = '/'): ContextGraph {
  return seedContextGraph(configFor(), route)
}

describe('seedContextGraph', () => {
  it('inherits the tenant and locale from the resolved config', () => {
    const graph = seedContextGraph(configFor('acme-hotels'), '/rooms')

    expect(graph.tenantId).toBe('acme-hotels')
    expect(graph.page.locale).toBe('id')
    expect(graph.page.route).toBe('/rooms')
  })

  it('starts anonymous and actionless', () => {
    const graph = seeded()

    // The graph must never bootstrap into an authenticated or capable state;
    // both are granted by events and the capability filter respectively.
    expect(graph.session).toEqual({ authenticated: false })
    expect(graph.entities).toEqual([])
    expect(graph.availableActions).toEqual([])
    expect(graph.errors).toEqual([])
    expect(graph.comparison).toEqual({ entityIds: [] })
  })

  it('is serialisable, so a turn snapshot can be replayed (PRD §16)', () => {
    const graph = foldContextEvents(seeded(), [
      { type: 'page/route', route: '/rooms', kind: 'catalog' },
      { type: 'entities/set', entities: [{ id: 'suite-1', name: 'Suite One', kind: 'offer' }] },
    ])

    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph)
  })
})

describe('reduceContextGraph', () => {
  it('never mutates the graph it was given', () => {
    const graph = seeded('/')
    const snapshot = JSON.parse(JSON.stringify(graph)) as ContextGraph

    reduceContextGraph(graph, { type: 'page/route', route: '/rooms', kind: 'catalog' })
    reduceContextGraph(graph, {
      type: 'entities/set',
      entities: [{ id: 'x', name: 'X', kind: 'product' }],
    })
    reduceContextGraph(graph, { type: 'session/authenticated', role: 'guest' })
    reduceContextGraph(graph, {
      type: 'form/set',
      form: {
        id: 'booking_request',
        completedFields: [],
        pendingFields: [],
        maskedFields: [],
      },
    })

    expect(graph).toEqual(snapshot)
  })

  describe('page events', () => {
    it('keeps the existing kind when a route event omits it', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'page/route', route: '/rooms', kind: 'catalog' },
        { type: 'page/route', route: '/rooms/suite' },
      ])
      expect(graph.page.kind).toBe('catalog')
    })

    it('records the active panel, and clears it with null', () => {
      const opened = reduceContextGraph(seeded(), { type: 'page/activePanel', panel: 'compare' })
      expect(opened.activePanel).toBe('compare')

      const closed = reduceContextGraph(opened, { type: 'page/activePanel', panel: null })
      // null means "no panel"; it must land as absent, not as a JSON null.
      expect(closed.activePanel).toBeUndefined()
    })

    it('tracks locale changes', () => {
      const graph = reduceContextGraph(seeded(), { type: 'page/locale', locale: 'en' })
      expect(graph.page.locale).toBe('en')
    })
  })

  describe('entity events', () => {
    it('replaces the whole selection on set', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'entities/set', entities: [{ id: 'a', name: 'A', kind: 'product' }] },
        { type: 'entities/set', entities: [{ id: 'b', name: 'B', kind: 'offer' }] },
      ])
      expect(graph.entities.map((entity) => entity.id)).toEqual(['b'])
    })

    it('adds a named stub for an id the host did not describe', () => {
      const graph = reduceContextGraph(seeded(), { type: 'entities/select', entityId: 'suite-9' })
      expect(graph.entities).toEqual([{ id: 'suite-9', name: 'suite-9', kind: 'unknown' }])
    })

    it('leaves the graph untouched when the entity is already selected', () => {
      const graph = reduceContextGraph(seeded(), { type: 'entities/select', entityId: 'suite-9' })
      const again = reduceContextGraph(graph, { type: 'entities/select', entityId: 'suite-9' })

      expect(again).toBe(graph)
    })

    it('clears the selection on deselect', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'entities/select', entityId: 'suite-9' },
        { type: 'entities/deselect' },
      ])
      expect(graph.entities).toEqual([])
    })
  })

  describe('form events', () => {
    const form = {
      id: 'booking_request',
      completedFields: ['dates'],
      pendingFields: ['guests', 'email'],
      maskedFields: ['email'],
    }

    it('moves a completed field out of pending without duplicating it', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'form/set', form },
        { type: 'form/fieldCompleted', field: 'guests' },
        { type: 'form/fieldCompleted', field: 'guests' },
      ])

      expect(graph.form?.completedFields).toEqual(['dates', 'guests'])
      expect(graph.form?.pendingFields).toEqual(['email'])
    })

    it('keeps masked field names distinct from values (PRD §16)', () => {
      const graph = reduceContextGraph(seeded(), { type: 'form/set', form })

      // `maskedFields` records *names*. A form value must never be reachable
      // through the graph, or masking downstream is too late to matter.
      expect(graph.form?.maskedFields).toEqual(['email'])
      expect(JSON.stringify(graph)).not.toContain(' Booker ')
    })

    it('ignores field completion when there is no form', () => {
      const graph = reduceContextGraph(seeded(), { type: 'form/fieldCompleted', field: 'guests' })
      expect(graph.form).toBeUndefined()
    })

    it('clears the form on a null set', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'form/set', form },
        { type: 'form/set', form: null },
      ])
      expect(graph.form).toBeUndefined()
    })
  })

  describe('session events', () => {
    it('carries only an opaque customer ref, never profile data', () => {
      const graph = reduceContextGraph(seeded(), {
        type: 'session/authenticated',
        role: 'member',
        customerRef: 'cust_abc',
      })
      expect(graph.session).toEqual({
        authenticated: true,
        role: 'member',
        customerRef: 'cust_abc',
      })
    })

    it('drops role and ref on sign-out', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'session/authenticated', role: 'member', customerRef: 'cust_abc' },
        { type: 'session/anonymous' },
      ])
      expect(graph.session).toEqual({ authenticated: false })
    })
  })

  describe('cart, checkout and error events', () => {
    it('clears the cart on a null set', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'cart/set', cart: { currency: 'IDR', lineCount: 2, subtotal: 900000 } },
        { type: 'cart/set', cart: null },
      ])
      expect(graph.cart).toBeUndefined()
    })

    it('accepts a host-supplied subtotal alongside the line count', () => {
      const graph = reduceContextGraph(seeded(), {
        type: 'cart/set',
        cart: { currency: 'IDR', lineCount: 2, subtotal: 900000 },
      })
      expect(graph.cart?.subtotal).toBe(900000)
      expect(graph.cart?.lineCount).toBe(2)
    })

    it('records and clears errors alongside ordinal checkout state', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'checkout/step', step: 'payment', index: 2, total: 4 },
        {
          type: 'error/recorded',
          code: 'booking_slot_unavailable',
          occurredAt: '2026-04-01T09:00:00.000Z',
        },
      ])

      expect(graph.checkout).toEqual({ step: 'payment', index: 2, total: 4 })
      expect(graph.errors).toEqual([
        { code: 'booking_slot_unavailable', occurredAt: '2026-04-01T09:00:00.000Z' },
      ])

      expect(reduceContextGraph(graph, { type: 'error/cleared' }).errors).toEqual([])
    })
  })

  describe('action events', () => {
    it('sets the publishable action list and toggles one', () => {
      const graph = foldContextEvents(seeded(), [
        { type: 'action/set', actions: [{ name: 'booking.reserve', enabled: true }] },
        { type: 'action/enabled', name: 'booking.reserve', enabled: false },
      ])
      expect(graph.availableActions).toEqual([{ name: 'booking.reserve', enabled: false }])
    })

    it('ignores a toggle for an action that was never set', () => {
      const graph = reduceContextGraph(seeded(), {
        type: 'action/enabled',
        name: 'booking.reserve',
        enabled: true,
      })
      expect(graph.availableActions).toEqual([])
    })
  })
})

describe('foldContextEvents', () => {
  it('replays an ordered list deterministically', () => {
    const events: readonly ContextEvent[] = [
      { type: 'page/route', route: '/rooms', kind: 'catalog' },
      { type: 'page/section', section: 'availability' },
      { type: 'entities/select', entityId: 'suite-1' },
      { type: 'comparison/set', entityIds: ['suite-1'], metric: 'rate' },
    ]

    const once = foldContextEvents(seeded(), events)
    const twice = foldContextEvents(seeded(), events)

    expect(once).toEqual(twice)
    expect(once.page.section).toBe('availability')
    expect(once.comparison).toEqual({ entityIds: ['suite-1'], metric: 'rate' })
  })
})

describe('actionableContext', () => {
  const graph = foldContextEvents(seeded(), [
    {
      type: 'action/set',
      actions: [
        { name: 'booking.reserve', enabled: true },
        { name: 'payment.refund', enabled: true },
      ],
    },
  ])

  it('drops actions the capability tier does not permit', () => {
    const narrowed = actionableContext(graph, ['booking.reserve'])
    expect(narrowed.availableActions.map((action) => action.name)).toEqual(['booking.reserve'])
  })

  it('never widens: an empty capability list yields no actions', () => {
    // This is the PRD §18 guard. Page state may narrow what a capability
    // allows; it must never manufacture an action the capability forbids.
    expect(actionableContext(graph, []).availableActions).toEqual([])
  })

  it('preserves the rest of the graph so page context survives', () => {
    const narrowed = actionableContext(graph, ['booking.reserve'])
    expect(narrowed.page).toEqual(graph.page)
    expect(narrowed.tenantId).toBe('acme-hotels')
    expect(narrowed.entities).toEqual(graph.entities)
  })
})

describe('parseContextGraph', () => {
  it('round-trips a valid graph from the wire', () => {
    const graph = seeded('/rooms')
    expect(parseContextGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph)
  })

  it('rejects a graph with no tenant instead of defaulting one', () => {
    expect(() =>
      parseContextGraph({ page: { route: '/', kind: 'home', locale: 'id' } }),
    ).toThrow(/tenantId/)
  })

  it('rejects a form that smuggles a value where a field name belongs', () => {
    const raw = seeded('/')
    expect(() =>
      parseContextGraph({
        ...raw,
        form: {
          id: 'booking_request',
          completedFields: [],
          pendingFields: [{ not: 'a field name' }],
          maskedFields: [],
        },
      }),
    ).toThrow(/Invalid context graph/)
  })
})
