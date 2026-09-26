/**
 * A page, wired: SDK in, chat shell out, one turn between them.
 *
 * This is the integration PRD §24 describes as the seam a host writes against,
 * and the shape of it is three lines: initialise the SDK, observe the page, run
 * the turn. Everything hard about a page is not in the wiring — it is in the
 * order. Consent before observation, observation before the turn, the turn
 * before any drawing. Doing those out of order does not produce a degraded
 * page, it produces a page that leaks.
 *
 * What this module deliberately does *not* do:
 *
 * - **It runs no action.** `action_requested` arrives with the gate's own
 *   decision recorded on the page; the turn pipeline decides again, with the
 *   confirmation as an input. A page that executed an action directly would be
 *   a second policy gate nobody tests (§18).
 * - **It holds no key, and no clock.** `now` is the page's, and the timestamp a
 *   turn carries is the timestamp the page supplied.
 * - **It is the only place that knows the DOM.** One exported function takes a
 *   host element and a document; everything else in the app calls through here,
 *   so a fake document is enough to test the page and a real one is enough to
 *   run it.
 */
import { mount, type ChatEvent, type ChatHandle, type ChatHostLike } from '@archava/chat'
import type { TurnOutcome } from '@archava/assistant'
import type { Entity } from '@archava/config'
import type { ContextGraph } from '@archava/core'
import {
  init,
  type Archava,
  type ArchavaAnalyticsEvent,
  type ArchavaInit,
  type ScoutDocument,
} from '@archava/sdk'
import { SLICE_CLIENT_ID, createSlice, type Slice, type SliceRequest } from './slice.js'
import {
  pageEntityResolver,
  pageExecutor,
  surfaceEntityIds,
  surfaceMarkup,
  type SurfaceDocument,
  type SurfaceElement,
  type SurfaceUnit,
} from './surface.js'

/** The options a page is mounted with. Everything else has a safe default. */
export interface SlicePageOptions {
  /** The element the chat shell draws into. */
  readonly host: ChatHostLike
  /** The page the SDK reads. A browser passes `window.document`. */
  readonly document: ScoutDocument
  /** The tenant joint. Defaults to the reference tenant. */
  readonly slice?: Slice
  /** Consent the host already obtained. Absent means the SDK starts with none. */
  readonly consent?: ArchavaInit['consent']
  /** The route this page is. Cross-checked against the graph the SDK built. */
  readonly route?: string
  /**
   * The session this page's turns belong to. Absent mints one at mount.
   *
   * Supplied by a host that already knows who is visiting — an authenticated
   * app, a support desk — so a turn carries the session the host recognises
   * rather than an anonymous one it has never seen.
   */
  readonly sessionId?: string
  /** The clock, injected. A page with none injected reads the wall clock. */
  readonly now?: () => string
  /** Where §27 analytics events go (shape only — no payload, no provider). */
  readonly onAnalytics?: (event: ArchavaAnalyticsEvent) => void
  /** Draw the §16 inspector alongside the transcript. */
  readonly inspect?: boolean
}

/** The handle a page keeps, so it can ask and tear down. */
export interface SlicePage {
  readonly chat: ChatHandle
  readonly sdk: Archava
  readonly slice: Slice
  /** The tenant's bookable entities, as the page rendered them. */
  readonly units: readonly Entity[]
  /** Draw the tenant's surface into the page, and say what it rendered. */
  renderSurface(): readonly string[]
  /** Run one turn from a visitor's words, and draw its outcome. */
  ask(utterance: string, confirmedActionIds?: readonly string[]): Promise<TurnOutcome>
  /** The graph the last turn ran against, as the SDK last saw the page. */
  graph(): ContextGraph
  /** Page-level notes — a decline, a refused mount — that no turn produced. */
  notes(): readonly string[]
  /** Actions the visitor declined this session, in the order they were refused. */
  declinedActionIds(): readonly string[]
  destroy(): void
}

/** The element the surface is drawn into. */
const SURFACE_HOST = '#surface'

/** One config entity as the surface needs it. */
function toSurfaceUnit(entity: Entity): SurfaceUnit {
  return { id: entity.id, name: entity.name, kind: entity.kind, summary: entity.summary }
}

/** The element a document has for a selector, or `null` when it has none. */
function query(
  document: { querySelector?(selector: string): Element | null } | undefined,
  selector: string,
): Element | null {
  return document?.querySelector?.(selector) ?? null
}

/**
 * An element as the surface's structural executor can see it.
 *
 * The narrowing from `Element` rather than `HTMLElement` is deliberate: a
 * `querySelector` hands back an `Element`, and what the executor needs from one
 * is smaller than either of those. The two members only an HTML element carries
 * — `hidden`, and scrolling — are read and written through `instanceof`, so a
 * selector that found something else reports itself as visible and unscrolled
 * instead of throwing into the middle of an execution.
 */
function asSurfaceElement(element: Element): SurfaceElement {
  return {
    getAttribute: (name: string) => element.getAttribute(name),
    setAttribute: (name: string, value: string) => element.setAttribute(name, value),
    removeAttribute: (name: string) => element.removeAttribute(name),
    get innerHTML() {
      return element.innerHTML
    },
    set innerHTML(value: string) {
      element.innerHTML = value
    },
    get hidden() {
      return element instanceof HTMLElement ? element.hidden : false
    },
    set hidden(value: boolean) {
      if (element instanceof HTMLElement) element.hidden = value
    },
    classList: {
      add: (name: string) => element.classList.add(name),
      remove: (name: string) => element.classList.remove(name),
    },
    scrollIntoView: (options?: { behavior?: string; block?: string }) =>
      element.scrollIntoView(options as ScrollIntoViewOptions | undefined),
    querySelector: (selector: string) => asSurfaceElementOptional(element.querySelector(selector)),
    get textContent() {
      return element.textContent
    },
  }
}

function asSurfaceElementOptional(element: Element | null): SurfaceElement | null {
  return element === null ? null : asSurfaceElement(element)
}

/**
 * A document as the surface's structural executor can see it.
 *
 * The cast is in one place and only two methods wide: the executor's view of a
 * page is deliberately narrower than `Document`, and writing that narrowing
 * out by hand at each call site would be a second place for it to drift.
 */
function asSurfaceDocument(document: unknown): SurfaceDocument {
  const host = document as {
    querySelector?(selector: string): Element | null
    querySelectorAll?(selector: string): NodeListOf<Element> | readonly Element[]
  }
  return {
    querySelector: (selector: string) =>
      asSurfaceElementOptional(host.querySelector?.(selector) ?? null),
    querySelectorAll: (selector: string) =>
      Array.from(host.querySelectorAll?.(selector) ?? []).map(asSurfaceElement),
  }
}

/**
 * Draw the tenant's surface, and report what it rendered.
 *
 * A page without a `#surface` is not broken — it is a page that has chosen to
 * show no entities, and the turn that follows will be grounded on an empty
 * graph because that is what the visitor is looking at. Saying so as a note is
 * the difference between an empty graph and a silently missing page.
 */
function renderSurface(
  document: unknown,
  units: readonly Entity[],
): { readonly notes: readonly string[] } {
  const host = query(document as { querySelector?(selector: string): Element | null }, SURFACE_HOST)
  if (host === null) return { notes: [`no ${SURFACE_HOST} element; the page shows no entities`] }

  const surfaceUnits = units.map(toSurfaceUnit)
  host.innerHTML = surfaceMarkup(surfaceUnits)
  return { notes: [`rendered ${surfaceUnits.length} entities`] }
}

/** The clock, when the page did not supply one. Only here, never in a turn. */
const wallClock = (): string => new Date().toISOString()

/**
 * A session id, when the page did not supply one.
 *
 * The SDK's session deliberately has no id of its own — it is a handle over one
 * visitor's graph, not a record of them. But a turn belongs to a *session*, and
 * the tenant id is not one: two visitors on the same tenant sharing a session id
 * would share that session's approvals and handoffs, which is exactly the
 * cross-visitant leak §16 exists to prevent. So the page mints one at mount and
 * keeps it for the life of the page.
 */
function newSessionId(): string {
  const generator = globalThis.crypto
  if (generator !== undefined && typeof generator.randomUUID === 'function') {
    return generator.randomUUID()
  }
  return `anon-${Math.random().toString(36).slice(2)}`
}

/**
 * Mount the slice onto a page.
 *
 * The SDK is initialised before anything is observed, and the chat is mounted
 * before the first turn can be run, so a visitor cannot send a message into a
 * shell that does not exist yet. Neither is defensive: both are the only
 * ordering in which the page is telling the truth.
 */
export function mountSlicePage(options: SlicePageOptions): SlicePage {
  const slice = options.slice ?? createSlice()
  const now = options.now ?? wallClock
  const route = options.route ?? '/'
  const sessionId = options.sessionId ?? newSessionId()
  const notes: string[] = []
  /**
   * Actions the visitor has declined, for the life of the page.
   *
   * A set rather than a list because a decline is a fact about the action, not an
   * event: declining the same booking twice is the same refusal, and the second
   * one produces no new `declined:` note.
   */
  const declined = new Set<string>()

  // The surface is drawn before the SDK observes anything, and the order is not
  // cosmetic: a scout that ran first would report a page with no entities, and
  // every turn after it would be grounded on an empty graph.
  const rendered = renderSurface(options.document, slice.units)
  notes.push(...rendered.notes)

  const sdk = init({
    clientId: options.slice === undefined ? SLICE_CLIENT_ID : slice.clientId,
    config: slice.config,
    route,
    ...(options.consent === undefined ? {} : { consent: options.consent }),
    ...(options.now === undefined ? {} : { now }),
    ...(options.document === undefined ? {} : { document: options.document }),
    ...(options.onAnalytics === undefined ? {} : { onAnalytics: options.onAnalytics }),
  })

  const chat = mount(options.host, {
    locale: slice.config.primaryLanguage,
    inspect: options.inspect ?? false,
    branding: slice.config.branding,
    // The document the shell builds in is the host's own, which the bridge read
    // from the element it was handed. The page's `document` is the SDK's: a
    // structural page to observe, a different shape entirely, and passing it
    // here would ask the shell to build in something it cannot.
    onEvent: (event: ChatEvent) => {
      // The shell draws and reports; it never runs an action and never decides
      // one. What a click means is answered here, and only by handing the turn
      // pipeline the confirmation the visitor just gave.
      if (event.kind === 'message_submitted') {
        void ask(event.text)
        return
      }
      if (event.kind === 'action_requested') {
        // The label is the visitor's own words for the action, so it is the
        // utterance the pipeline should treat as the confirmation.
        void ask(event.label, [event.actionId])
        return
      }
      if (event.kind === 'handoff_requested') {
        void ask(event.label, [], { handoffRequested: true })
        return
      }
      // A decline is a fact about the page, not a turn: there is no utterance,
      // no brain, and no §27 event. Dropping it would lose the refusal the
      // visitor made, so it is kept where a page can show it.
      if (event.kind === 'action_declined') {
        // A decline is a fact about the session, so it is remembered as one. The
        // notes array below is what a page can show, but showing is not all of it:
        // without the tracking set the same action is offered and asked again on
        // the next turn that mentions it, which is the gate looping on the visitor
        // rather than the visitor having changed their mind. Once recorded here it
        // reaches the gate as `declinedActionIds`, which answers
        // `declined_by_visitor` and stops the asking.
        //
        // The entry is deliberately not retracted by a later confirmation. A
        // confirmation wins in the same turn — that is `declinedActionIds` versus
        // `confirmedActionIds` in the gate — but what sticks after the turn is the
        // newest thing the visitor said about the action, so re-adding it here
        // after a confirm would resurrect the refusal.
        declined.add(event.actionId)
        notes.push(`declined:${event.actionId}`)
      }
    },
  })

  /** The turn, with the page's graph and the page's clock, every time. */
  async function ask(
    utterance: string,
    confirmedActionIds: readonly string[] = [],
    extra: Partial<SliceRequest> = {},
  ): Promise<TurnOutcome> {
    // The two collaborators an id-bearing action needs, both bound to this one
    // page. The resolver answers "is this on screen" from what was rendered —
    // a page's own memory, not the tenant's catalog — and the executor is what
    // makes an allowed action visible instead of merely permitted. Supplying
    // neither is also a valid page: the gate decides all the same, and every
    // allowed action comes back `not_attempted`.
    const surface = asSurfaceDocument(options.document)
    const resolver = pageEntityResolver(surfaceEntityIds(slice.units))
    const executor = pageExecutor(surface)

    // Read the page first, then fold the whole of what has been read.
    //
    // `observe()` returns what changed in *this* read, not the page: a page that
    // has already been read once returns nothing new, and folding that nothing
    // over a fresh seed produces a graph of an empty page — a page with no
    // entities and no actions. That graph is then used to *narrow* the gate
    // (§16), so the second turn of a session would be denied every action it was
    // denied on turn one... except the ones nothing on the page had ever
    // mentioned. The visitor sees the assistant forget the page it answered on
    // one turn ago. `history()` is the accumulated reading, which is the thing a
    // turn actually runs against.
    sdk.observe()

    const request: SliceRequest = {
      utterance,
      graph: slice.graph(sdk.history(), route),
      occurredAt: now(),
      sessionId,
      resolver,
      executor,
      ...(confirmedActionIds.length === 0 ? {} : { confirmedActionIds }),
      // Only sent when something has actually been declined. An empty array is
      // the same meaning as absent — nothing declined — so the conditional spread
      // keeps the caller's "nothing to say" from being encoded as a claim.
      ...(declined.size === 0 ? {} : { declinedActionIds: [...declined] }),
      ...extra,
    }
    const outcome = await slice.ask(request)
    // Then the page is read again, because the turn just changed it. An executor
    // that succeeded has already drawn — the panel is open, the card carries
    // `data-archava-current` — and a graph that is never re-read after the
    // drawing is a graph that says the panel is still closed. That is not a
    // cosmetic staleness: the next turn observes this same page, so a page that
    // does not re-read itself hands the pipeline a lie about what the visitor
    // is looking at. Re-reading against the page as it now stands is what makes
    // `graph()` a description of the present rather than of the last request.
    sdk.observe()
    chat.show(outcome)
    return outcome
  }

  return {
    chat,
    sdk,
    slice,
    units: slice.units,
    renderSurface: () => surfaceEntityIds(slice.units),
    ask: (
      utterance: string,
      // Forwarded, because a host that has already shown a confirmation card and
      // got a yes has to be able to say so. Dropping the list here is not a
      // smaller API — it is the same API that answers every "after all, do it"
      // click with another confirmation card, which is the re-ask loop the
      // decline gate exists to stop.
      confirmedActionIds?: readonly string[],
    ) => ask(utterance, confirmedActionIds ?? []),
    graph: () => slice.graph(sdk.history(), route),
    notes: () => [...notes],
    /** What the visitor has refused, so a host page can show it and a test can assert it. */
    declinedActionIds: () => [...declined],
    destroy: () => {
      chat.destroy()
      sdk.destroy()
    },
  }
}
