import { describe, expect, it } from 'vitest'
import { DEFAULT_SELECTORS, readDom, SdkEnvironmentError } from '../src/index.js'
import type { ScoutDocument, ScoutNode, ScoutNodeList } from '../src/index.js'

/**
 * A DOM built by hand.
 *
 * Every node here is deliberately missing `value`. That is the property under
 * test: the scout reads `name` attributes off fields it already holds, and a
 * `.value` access would be a §16 violation no amount of downstream masking
 * could undo.
 */
function node(extra: ScoutNode = {}): ScoutNode {
  return { tagName: 'DIV', ...extra }
}

function list(...nodes: readonly ScoutNode[]): ScoutNodeList {
  const byIndex: Record<number, ScoutNode> = {}
  nodes.forEach((n, index) => {
    byIndex[index] = n
  })
  return {
    length: nodes.length,
    item: (index: number) => byIndex[index] ?? null,
    ...byIndex,
  }
}

function attrs(...pairs: ReadonlyArray<readonly [string, string]>) {
  const entries = pairs.map(([, value]) => ({ value }))
  const byName = new Map(pairs.map(([name, value]) => [name, { value }]))
  const byIndex: Record<number, { value: string }> = {}
  entries.forEach((entry, index) => {
    byIndex[index] = entry
  })
  return {
    length: entries.length,
    getNamedItem: (name: string) => byName.get(name) ?? null,
    item: (index: number) => byIndex[index] ?? null,
    ...byIndex,
  }
}

function document(overrides: Partial<ScoutDocument> = {}): ScoutDocument {
  return {
    location: { pathname: '/rooms', href: 'https://example.test/rooms' },
    documentElement: { lang: 'id' },
    querySelectorAll: () => list(),
    ...overrides,
  }
}

function entity(id: string, name: string, kind = 'room'): ScoutNode {
  return node({
    id,
    textContent: name,
    attributes: attrs(['data-archava-entity', id], ['data-archava-kind', kind]),
  })
}

function action(name: string, disabled = false): ScoutNode {
  return node({
    attributes: attrs(
      ['data-archava-action', name],
      ['aria-disabled', disabled ? 'true' : 'false'],
    ),
  })
}

function field(name: string, checked = false): ScoutNode {
  return node({ tagName: 'INPUT', checked, attributes: attrs(['name', name]) })
}

/** A document that answers one selector with nodes and everything else empty. */
function answering(
  selector: string,
  nodes: readonly ScoutNode[],
  rest: Partial<ScoutDocument> = {},
): ScoutDocument {
  return document({
    querySelectorAll: (s) => (s === selector ? list(...nodes) : list()),
    ...rest,
  })
}

const NOW = '2026-04-01T00:00:00.000Z'

describe('readDom', () => {
  it('refuses to guess when there is no document', () => {
    // Finding no DOM is a host bug, and a scout that silently returned an empty
    // page would claim the visitor saw nothing.
    expect(() => readDom(null, NOW)).toThrow(SdkEnvironmentError)
    expect(() => readDom(undefined, NOW)).toThrow(SdkEnvironmentError)
  })

  it('degenerates to an empty page when the DOM answers nothing', () => {
    expect(readDom(document(), NOW)).toEqual({
      path: '/rooms',
      kind: 'home',
      locale: 'id',
      entities: [],
      actions: [],
      errors: [],
    })
  })

  it('reads the path and locale the host reports', () => {
    expect(readDom(document(), NOW)).toMatchObject({ path: '/rooms', locale: 'id' })
    expect(readDom(document({ location: {}, documentElement: {} }), NOW)).toMatchObject({
      path: '/',
      locale: 'en',
    })
  })

  it('reads visible entities by id and label, with a kind when the host gives one', () => {
    const read = readDom(
      answering(DEFAULT_SELECTORS.entity, [entity('room-1', 'Deluxe Suite')]),
      NOW,
    )

    expect(read.entities).toEqual([{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }])
  })

  it('reads an aria-label over the card text, which is a name, a summary and controls concatenated', () => {
    const card = node({
      id: 'room-1',
      textContent: 'Deluxe Suite\n  King bed, terrace\n  Compare  Show me',
      attributes: attrs(
        ['data-archava-entity', 'room-1'],
        ['data-archava-kind', 'room'],
        ['aria-label', 'Deluxe Suite'],
      ),
    })
    const read = readDom(answering(DEFAULT_SELECTORS.entity, [card]), NOW)

    expect(read.entities).toEqual([{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }])
  })

  it('falls back to the node id when an entity has no label', () => {
    const bare = node({ id: 'room-9', attributes: attrs(['data-archava-entity', 'room-9']) })
    const read = readDom(answering(DEFAULT_SELECTORS.entity, [bare]), NOW)

    expect(read.entities).toEqual([{ id: 'room-9', name: 'room-9', kind: 'unknown' }])
  })

  it('skips an entity with no id at all', () => {
    const read = readDom(
      answering(DEFAULT_SELECTORS.entity, [node({ textContent: 'orphan' })]),
      NOW,
    )

    expect(read.entities).toEqual([])
  })

  it('reports an action as disabled when the page says so, and only then', () => {
    const read = readDom(
      answering(DEFAULT_SELECTORS.action, [action('add_to_cart'), action('pay', true)]),
      NOW,
    )

    expect(read.actions).toEqual([
      { name: 'add_to_cart', enabled: true },
      { name: 'pay', enabled: false },
    ])
  })

  it('reads a form as field names only, with selection state as completion', () => {
    const form = node({
      id: 'booking',
      attributes: attrs(['data-archava-form', 'booking'], ['data-archava-step', '2']),
      querySelectorAll: (s: string) =>
        s === DEFAULT_SELECTORS.field
          ? list(field('dates', true), field('guests', false), field('password', true))
          : list(),
    })
    const read = readDom(answering(DEFAULT_SELECTORS.form, [form]), NOW)

    // A ticked checkbox is completed; a text input is pending, because deciding
    // "finished" would mean reading a value, and reading a value is §16.
    expect(read.form).toEqual({
      id: 'booking',
      step: '2',
      completedFields: ['dates', 'password'],
      pendingFields: ['guests'],
      maskedFields: ['password'],
    })
  })

  it('reports no form when the page has none', () => {
    expect(readDom(document(), NOW).form).toBeUndefined()
  })

  it('reads the active panel, the section, and a checked comparison', () => {
    const panel = node({ id: 'filters', attributes: attrs(['data-archava-panel', 'filters']) })
    const compared = node({ attributes: attrs(['data-archava-compare', 'room-2']) })
    const section = node({ textContent: '  Deluxe Suites  ' })
    const read = readDom(
      document({
        querySelectorAll: (s) => {
          if (s === DEFAULT_SELECTORS.panel) return list(panel)
          if (s === DEFAULT_SELECTORS.comparison) return list(compared)
          if (s === DEFAULT_SELECTORS.section) return list(section)
          return list()
        },
      }),
      NOW,
    )

    expect(read.activePanel).toBe('filters')
    expect(read.section).toBe('Deluxe Suites')
    expect(read.comparison).toEqual({ entityIds: ['room-2'] })
  })

  it('omits a comparison and a panel the page did not render', () => {
    const read = readDom(document(), NOW)

    expect(read.comparison).toBeUndefined()
    expect(read.activePanel).toBeUndefined()
  })

  it('reads visible errors, dated by the host clock rather than its own', () => {
    const alert = node({ attributes: attrs(['data-archava-error', 'rate_unavailable']) })
    const read = readDom(answering(DEFAULT_SELECTORS.error, [alert]), NOW)

    // The scout has no Date access: `occurredAt` arrives as an argument, so the
    // times in the graph are times a human actually saw.
    expect(read.errors).toEqual([{ code: 'rate_unavailable', occurredAt: NOW }])
  })

  it('honours the selectors a host passes instead of the defaults', () => {
    const read = readDom(
      document({ querySelectorAll: () => list(node({ textContent: 'Anything' })) }),
      NOW,
      { ...DEFAULT_SELECTORS, section: '.my-section' },
    )

    expect(read.section).toBe('Anything')
  })
})
