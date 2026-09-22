import { describe, expect, it } from 'vitest'
import {
  GENERATIVE_COMPONENT_KINDS,
  GENERATIVE_PROP_SCHEMAS,
  TRANSACTION_STAGES,
  GenerativeUIError,
  buildComponent,
  buildComponents,
  filterComponentsByAllowedActions,
  type GenerativeComponent,
} from '../src/index.js'

/**
 * The §25 rule is one sentence: "Model output selects from a validated registry
 * and supplies validated props. It does not execute arbitrary client-side
 * code." Every test here is that sentence with the "does not" half proved.
 */
describe('the component registry', () => {
  it('is the closed set the PRD names', () => {
    expect([...GENERATIVE_COMPONENT_KINDS]).toEqual([
      'recommendation_list',
      'comparison_table',
      'booking_picker',
      'product_shortlist',
      'order_summary',
      'faq_source_card',
      'cta',
      'human_handoff_card',
    ])
  })

  it('gives every kind its own prop schema', () => {
    for (const kind of GENERATIVE_COMPONENT_KINDS) {
      expect(GENERATIVE_PROP_SCHEMAS[kind]).toBeDefined()
    }
    expect(Object.keys(GENERATIVE_PROP_SCHEMAS).sort()).toEqual(
      [...GENERATIVE_COMPONENT_KINDS].sort(),
    )
  })

  it('does not let one kind be handed another kind props', () => {
    expect(() =>
      buildComponent({
        kind: 'comparison_table',
        props: {
          items: [{ entityId: 'e1', entityName: 'Acme', reason: 'why', sourceId: null }],
        },
      }),
    ).toThrow(GenerativeUIError)
  })
})

describe('buildComponent', () => {
  it('rejects an invented kind', () => {
    expect(() => buildComponent({ kind: 'arbitrary_widget', props: {} })).toThrow(
      GenerativeUIError,
    )
  })

  it('names the kind when its props are wrong', () => {
    // The kind is in the message because a rejection the operator cannot trace
    // back to a specific component is a rejection nobody fixes.
    expect(() => buildComponent({ kind: 'cta', props: { label: 'Book now' } })).toThrow(/cta/)
  })

  it('keeps a sourceId nullable so provenance may be absent', () => {
    const component = buildComponent({
      kind: 'recommendation_list',
      props: {
        items: [{ entityId: 'r1', entityName: 'Room 12', reason: 'sea view', sourceId: null }],
      },
    })
    expect(component.kind).toBe('recommendation_list')
  })

  it('requires an order summary amount to carry its currency', () => {
    expect(() =>
      buildComponent({ kind: 'order_summary', props: { orderId: 'o1', amountMinor: 100 } }),
    ).toThrow(GenerativeUIError)

    const component = buildComponent({
      kind: 'order_summary',
      props: { orderId: 'o1', amountMinor: 100, currency: 'IDR', stage: 'payment_pending' },
    })
    expect(component.kind).toBe('order_summary')
    if (component.kind === 'order_summary') {
      expect(component.props.amountMinor).toBe(100)
    }
  })
})

describe('buildComponents', () => {
  it('keeps what validates and reports what does not, dropping neither', () => {
    const built = buildComponents([
      { kind: 'cta', props: { label: 'Book', actionId: 'booking.create' } },
      { kind: 'not_a_kind', props: {} },
      { kind: 'product_shortlist', props: { entityIds: [] } },
    ])

    expect(built.components.map((component) => component.kind)).toEqual(['cta'])
    expect(built.rejected).toHaveLength(2)
    // A rejected component is never silent: each carries its own message.
    expect(built.rejected.every((message) => message.length > 0)).toBe(true)
  })

  it('accepts an empty list without inventing a component', () => {
    expect(buildComponents([])).toEqual({ components: [], rejected: [] })
  })
})

describe('filterComponentsByAllowedActions', () => {
  const cta = (actionId: string): GenerativeComponent =>
    buildComponent({ kind: 'cta', props: { label: 'Go', actionId } })

  const card = (): GenerativeComponent =>
    buildComponent({
      kind: 'faq_source_card',
      props: { sourceId: 's1', sourceTitle: 'Policy', excerpt: 'Excerpt text.' },
    })

  it('lets a non-CTA through without consulting the gate', () => {
    // The gate is about *actions*. A source card runs nothing.
    expect(filterComponentsByAllowedActions([card()], [])).toHaveLength(1)
  })

  it('drops a CTA whose action the gate did not allow', () => {
    const kept = filterComponentsByAllowedActions(
      [cta('booking.create'), cta('admin.config.update')],
      ['booking.create'],
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]?.kind).toBe('cta')
  })

  it('keeps every CTA when the gate allowed all of them', () => {
    const kept = filterComponentsByAllowedActions([cta('booking.create'), cta('cart.item.add')], [
      'booking.create',
      'cart.item.add',
    ])
    expect(kept).toHaveLength(2)
  })
})

describe('transaction stages', () => {
  it('is the §19 lifecycle in order', () => {
    expect([...TRANSACTION_STAGES]).toEqual([
      'discovery',
      'selection',
      'cart',
      'checkout',
      'payment_pending',
      'payment_confirmed',
      'confirmation_sent',
      'fulfillment',
      'support',
    ])
  })
})
