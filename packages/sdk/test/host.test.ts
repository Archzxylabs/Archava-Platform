import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTORS,
  SdkConfigError,
  SdkConsentError,
  SdkEnvironmentError,
  emptyConsent,
  init,
  install,
  withoutConsent,
  type ArchavaAnalyticsEvent,
  type ConsentState,
  type ScoutDocument,
  type ScoutNode,
  type ScoutNodeList,
} from '../src/index.js'

/**
 * What `init` is *for*, as the three promises the §24 snippet makes:
 *
 * 1. **One line.** `Archava.init({ clientId })` is the whole integration, and
 *    everything behind it is the session's job. This file tests the wiring and
 *    the two refusals, not the session again — `session.test.ts` owns those.
 * 2. **Consent first.** `observe` without `page_context` is a refusal, and a
 *    refusal leaves the host in the state it was in before the call: the next
 *    read after a grant describes the page in full, because the refused read
 *    never taught the SDK anything.
 * 3. **No key, no clock of its own.** The graph a host gets carries field names
 *    only (§16); times in it come from the clock the host supplied (§27).
 *
 * The DOM here is the same hand-built one `dom.test.ts` uses: no `value`
 * anywhere in it, because a `.value` read is a §16 violation no amount of
 * downstream masking can undo.
 */

function node(extra: ScoutNode = {}): ScoutNode {
  return { tagName: 'DIV', ...extra }
}

function list(...nodes: readonly ScoutNode[]): ScoutNodeList {
  const byIndex: Record<number, ScoutNode> = {}
  nodes.forEach((n, index) => {
    byIndex[index] = n
  })
  return { length: nodes.length, item: (index: number) => byIndex[index] ?? null, ...byIndex }
}

function attrs(...pairs: ReadonlyArray<readonly [string, string]>) {
  const byName = new Map(pairs.map(([name, value]) => [name, { value }]))
  const byIndex: Record<number, { value: string }> = {}
  pairs.forEach(([, value], index) => {
    byIndex[index] = { value }
  })
  return {
    length: pairs.length,
    getNamedItem: (name: string) => byName.get(name) ?? null,
    item: (index: number) => byIndex[index] ?? null,
    ...byIndex,
  }
}

const NOW = '2026-04-01T09:30:00.000Z'

/** A document that answers three selectors and nothing else. */
function catalog(): ScoutDocument {
  const room = node({
    id: 'room-1',
    textContent: 'Deluxe Suite',
    attributes: attrs(['data-archava-entity', 'room-1'], ['data-archava-kind', 'room']),
  })
  const action = node({
    attributes: attrs(['data-archava-action', 'add_to_cart'], ['aria-disabled', 'false']),
  })
  const alert = node({ attributes: attrs(['data-archava-error', 'rate_unavailable']) })
  return {
    location: { pathname: '/rooms', href: 'https://example.test/rooms' },
    documentElement: { lang: 'id' },
    querySelectorAll: (s) => {
      if (s === DEFAULT_SELECTORS.entity) return list(room)
      if (s === DEFAULT_SELECTORS.action) return list(action)
      if (s === DEFAULT_SELECTORS.error) return list(alert)
      return list()
    },
  }
}

describe('init and the one line it is meant to be', () => {
  it('refuses a blank client, because there is nowhere to scope the read to', () => {
    for (const clientId of ['', '   ']) {
      expect(() => init({ clientId })).toThrow(SdkConfigError)
    }
  })

  it('hands back the scope it was given and a graph to start from', () => {
    const archava = init({ clientId: 'client-xyz', route: '/rooms' })

    expect(archava.clientId).toBe('client-xyz')
    expect(archava.graph()).toMatchObject({
      tenantId: 'client-xyz',
      page: { route: '/rooms', kind: 'home', locale: 'en' },
      errors: [],
    })
  })

  it('refuses rather than guess when the host gave it no document', () => {
    // Nothing is injected here and there is no ambient DOM in this environment,
    // so the scout must say so. An empty page would claim the visitor saw
    // nothing, which is a lie the platform would then answer questions about.
    const archava = init({ clientId: 'client-xyz', consent: { page_context: true } })

    expect(() => archava.observe()).toThrow(SdkEnvironmentError)
    expect(archava.history()).toEqual([])
  })
})

describe('observe', () => {
  it('reads the host document and applies what changed', () => {
    const archava = init({
      clientId: 'client-xyz',
      consent: { page_context: true },
      document: catalog(),
      now: () => NOW,
    })

    const events = archava.observe()

    expect(events.map((event) => event.type)).toContain('entities/set')
    expect(archava.graph()).toMatchObject({
      entities: [{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }],
      availableActions: [{ name: 'add_to_cart', enabled: true }],
    })
    // The clock is the host's, so a replayed turn carries the time it happened.
    expect(archava.graph().errors).toEqual([{ code: 'rate_unavailable', occurredAt: NOW }])
  })

  it('reports nothing on a second look at the same page', () => {
    const archava = init({
      clientId: 'client-xyz',
      consent: { page_context: true },
      document: catalog(),
      now: () => NOW,
    })

    archava.observe()

    expect(archava.observe()).toEqual([])
    expect(archava.history().length).toBeGreaterThan(0)
  })

  it('refuses when page context was never granted, and teaches it nothing', () => {
    const archava = init({ clientId: 'client-xyz', document: catalog(), now: () => NOW })

    expect(() => archava.observe()).toThrow(SdkConsentError)

    archava.grant('page_context')

    // The read that was refused must not count as a first observation, or the
    // graph would stay empty while the host believes it described the page.
    expect(archava.observe().length).toBeGreaterThan(0)
    expect(archava.graph().entities).toEqual([{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }])
  })

  it('stops observing on revoke, and keeps what it lawfully held', () => {
    const archava = init({
      clientId: 'client-xyz',
      consent: { page_context: true },
      document: catalog(),
      now: () => NOW,
    })
    archava.observe()

    archava.revoke('page_context')

    expect(() => archava.observe()).toThrow(SdkConsentError)
    // Prospective only: what was lawfully held stays held. §16 does not ask for
    // retroactive amnesia, and a log that rewrites itself cannot be replayed.
    expect(archava.graph().entities).toEqual([{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }])
  })
})

describe('the analytics sink', () => {
  function withAnalytics(consent: { analytics?: boolean } = {}): ArchavaAnalyticsEvent[] {
    const seen: ArchavaAnalyticsEvent[] = []
    const archava = init({
      clientId: 'client-xyz',
      consent: { page_context: true, ...consent },
      document: catalog(),
      now: () => NOW,
      onAnalytics: (event) => seen.push(event),
    })
    archava.observe()
    archava.destroy()
    return seen
  }

  it('says nothing when the visitor said no', () => {
    expect(withAnalytics()).toEqual([])
    expect(withAnalytics({ analytics: false })).toEqual([])
  })

  it('records the graph shape and never a field value, when the visitor said yes', () => {
    const [event] = withAnalytics({ analytics: true })

    expect(event).toMatchObject({
      name: 'destroy',
      clientId: 'client-xyz',
      route: '/rooms',
      at: NOW,
    })
    expect(event?.graph.entities).toEqual([{ id: 'room-1', name: 'Deluxe Suite', kind: 'room' }])
    // The record carries names. A value has nowhere to be, so it cannot leak.
    expect(JSON.stringify(event)).not.toContain('value')
  })
})

describe('consent as the host drives it', () => {
  it('tells the host what changed, grant by grant', () => {
    const seen: ConsentState[] = []
    const archava = init({
      clientId: 'client-xyz',
      onConsentChange: (state) => seen.push(state),
    })

    archava.grant('page_context')
    archava.grant('analytics')

    expect(archava.consent()).toEqual({ page_context: true, identity: false, analytics: true })
    expect(seen).toEqual([
      { page_context: true, identity: false, analytics: false },
      { page_context: true, identity: false, analytics: true },
    ])
  })

  it('tells the host when a domain is withdrawn', () => {
    const seen: ConsentState[] = []
    const archava = init({
      clientId: 'client-xyz',
      consent: { page_context: true },
      onConsentChange: (state) => seen.push(state),
    })

    archava.revoke('page_context')

    expect(archava.consent().page_context).toBe(false)
    expect(seen).toEqual([{ page_context: false, identity: false, analytics: false }])
  })

  it('starts from everything refused and withdraws one domain at a time', () => {
    expect(emptyConsent()).toEqual({ page_context: false, identity: false, analytics: false })
    expect(withoutConsent(emptyConsent(), 'identity')).toEqual(emptyConsent())
    expect(
      withoutConsent({ page_context: true, identity: true, analytics: true }, 'identity'),
    ).toEqual({
      page_context: true,
      identity: false,
      analytics: true,
    })
  })
})

describe('install', () => {
  it('attaches the namespace once, so a re-included script does not clobber it', () => {
    const first: { Archava?: { init: typeof init } } = {}
    const second: { Archava?: { init: typeof init } } = {}

    install(first)
    install(first)
    install(second)

    expect(first.Archava).toBeDefined()
    expect(second.Archava).toBeDefined()
    expect(first.Archava).not.toBe(second.Archava)
  })

  it('does nothing when there is no global to attach to', () => {
    expect(() => install(undefined)).not.toThrow()
    expect(() => install(null)).not.toThrow()
  })
})

describe('destroy', () => {
  it('is idempotent and reports its own state', () => {
    const archava = init({ clientId: 'client-xyz' })

    expect(archava.destroyed()).toBe(false)
    archava.destroy()
    archava.destroy()

    expect(archava.destroyed()).toBe(true)
  })
})
