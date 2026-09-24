/**
 * The confirmation loop, closed.
 *
 * A decline used to be a display-only fact: the page noted it, the panel stopped
 * showing the held action, and nothing told the gate. So the next turn that
 * mentioned the same action asked again — not because the visitor had changed
 * their mind, but because the gate had no way to know they had spoken. The
 * visitor says no to a booking, and is asked about that booking one sentence
 * later.
 *
 * These drive the page the way a browser does — `mountSlicePage`, the chat
 * shell's own decline button, the page's own executor — and assert on what a
 * turn actually returned, not on what a function said.
 */
import { describe, expect, it } from 'vitest'
import type { ChatDocumentLike, ChatHostLike, ChatNodeLike, ChatRootLike } from '@archava/chat'
import type { Entity } from '@archava/config'
import type { TurnOutcome } from '@archava/assistant'
import { mountSlicePage, type SlicePage } from '../src/page.js'
import { createSlice } from '../src/slice.js'
import { surfaceMarkup, type SurfaceUnit } from '../src/surface.js'
import { FakePage } from './page-fixture.js'
import type { FakeNode } from './page-fixture.js'

/**
 * An element the shell can build in, that remembers its listeners.
 *
 * The listening is the point. The decline the page has to hear is emitted by the
 * click handler on a *drawn* button, so a test that wants to press decline must
 * reach the listener the shell attached — the same closure, with the same
 * `actionId`, that a browser finger would invoke. Capture it and the test walks
 * the whole real path: the shell draws a card attaching a listener, the listener
 * fires an event, the page hears it, and the next turn's gate is a different
 * gate than it was before.
 */
class FakeElement implements ChatNodeLike {
  // The shell's node contract declares `children` and `textContent` readonly —
  // it reads them — while a drawn element is a mutable thing that grows and is
  // rewritten. Widening the two here is the point of the fixture: the shell
  // writes through this interface, and the test reads what it wrote.
  children: FakeElement[] = []
  readonly listeners = new Map<string, Array<(event: { readonly type: string }) => void>>()
  readonly attrs = new Map<string, string>()
  textContent: string | null = null
  readonly tagName = 'div'

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  appendChild(child: ChatNodeLike): ChatNodeLike {
    if (child instanceof FakeElement) this.children.push(child)
    return child
  }
  removeChild(child: ChatNodeLike): ChatNodeLike {
    const at = this.children.indexOf(child as unknown as FakeElement)
    if (at >= 0) this.children.splice(at, 1)
    return child
  }
  replaceChild(fresh: ChatNodeLike, stale: ChatNodeLike): ChatNodeLike {
    const at = this.children.indexOf(stale as unknown as FakeElement)
    if (at >= 0) this.children[at] = fresh as unknown as FakeElement
    return fresh
  }
  addEventListener(type: string, listener: (event: { readonly type: string }) => void): void {
    const held = this.listeners.get(type) ?? []
    held.push(listener)
    this.listeners.set(type, held)
  }
  removeEventListener(): void {}

  /** The class names this element was drawn with, which is how the shell names its parts. */
  classes(names: readonly string[]): void {
    void names
  }

  /** Every descended element carrying `name` in its class list. */
  findByClass(name: string): readonly FakeElement[] {
    const found: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      const listed = (node.attrs.get('class') ?? '').split(/\s+/)
      if (listed.includes(name)) found.push(node)
      for (const child of node.children) walk(child)
    }
    walk(this)
    return found
  }

  /** Press every listener registered for `type`, as a click would. */
  click(type = 'click'): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type })
  }
}

function fakeDom(): ChatDocumentLike {
  return {
    createElement: () => new FakeElement(),
    createTextNode: () => new FakeElement(),
  } as unknown as ChatDocumentLike
}

/**
 * The host the shell builds into, holding the root so a test can find buttons.
 *
 * The root is a handle over the real drawing surface rather than a copy: the
 * shell appends into it, and what a test searches is what the shell drew.
 */
function chatHost(): { host: ChatHostLike; root: FakeElement } {
  const root = new FakeElement()
  const doc = fakeDom()
  const host: ChatHostLike = {
    // The shell resolves its document from the host, not from the shadow root —
    // a browser's `attachShadow` also offers an `ownerDocument`, but the shell
    // reads the one place both a real element and a fixture have in common. Put
    // it on the root instead and the mount fails closed with a `ChatEnvironment-
    // Error`, which is the shell refusing to build in something it cannot.
    ownerDocument: doc,
    setAttribute() {},
    getAttribute: () => null,
    attachShadow: (): ChatRootLike | null => root,
  }
  return { host, root }
}

/**
 * The page the SDK observes and the executor mutates.
 *
 * This is the reference page's own markup, parsed — not a stub that answers
 * `null` to everything. A page answering `null` for every query is worse than
 * no page: the scout reads "no entities", the gate answers
 * `action_unavailable_on_page`, and every assertion under it becomes a
 * tautology by way of a denial. So the fixture is built from
 * `surfaceMarkup(createSlice().units)`, the same bytes a browser would receive,
 * and the panel inside it is what the page's own executor reveals and rewrites.
 */
interface Page extends FakePage {
  readonly panel: FakeNode
}
/**
 * The tenant's entities as the surface draws them.
 *
 * The slice's own units, not a second list: a fixture that carried its own copy
 * would drift from the config the tests already pin, and a page whose cards
 * named different rooms would be testing a tenant nobody visits.
 */
function toUnit(entity: Entity): SurfaceUnit {
  return { id: entity.id, name: entity.name, kind: entity.kind, summary: entity.summary }
}

function pageDocument(): Page {
  const page = new FakePage()
  page.body.innerHTML = surfaceMarkup(createSlice().units.map(toUnit))
  const panel = page.querySelector('#panel')
  if (panel === null) throw new Error('the surface rendered no panel')
  // Assigned onto the fixture rather than spread from it: a spread copies own
  // properties and leaves the prototype behind, so the mount would receive an
  // object with `body` but no `querySelector` — a page the shell cannot read.
  return Object.assign(page, { panel })
}

interface Mount {
  readonly page: SlicePage
  readonly root: FakeElement
  readonly panel: FakeNode
  /** The drawn decline button for the action, pressed the way a visitor presses it. */
  decline(actionId: string): void
  /** The drawn confirm button for the action, likewise. */
  confirm(actionId: string): void
}

function mountPage(): Mount {
  const { host, root } = chatHost()
  const document = pageDocument()
  const page = mountSlicePage({
    host,
    // The page the fixture holds is the tenant's own markup, already in the
    // shape the SDK's scout reads.
    document,
    // A page that observes without consent is a page that reads before it is
    // asked. The SDK refuses the read rather than guessing, so the test says
    // yes the way a host with a consent banner would.
    consent: { page_context: true },
    now: () => '2026-09-23T10:00:00.000Z',
  })

  const buttonBy = (actionId: string, name: string): FakeElement => {
    const cards = root.findByClass('archava-confirmation').filter((card) => {
      return (card.attrs.get('data-action-id') ?? '') === actionId
    })
    const button = cards.at(-1)?.findByClass(name).at(-1)
    if (button === undefined) throw new Error(`no drawn ${name} for ${actionId}`)
    return button
  }

  return {
    page,
    root,
    panel: document.panel,
    decline: (actionId) => buttonBy(actionId, 'archava-confirmation-decline').click(),
    confirm: (actionId) => buttonBy(actionId, 'archava-confirmation-confirm').click(),
  }
}

/** The one gated action a turn named, by id. */
function gated(outcome: TurnOutcome, actionId: string) {
  return outcome.actions.find((action) => action.actionId === actionId)
}

describe('a visitor who declines a confirmation', () => {
  it('hears the refusal through the button the shell actually drew', async () => {
    const mounted = mountPage()
    await mounted.page.ask('book the garden twin room')
    // The card exists because the shell drew it for a held action, and the
    // listener on it is the shell's own. Pressing it is the whole test setup:
    // everything after this is the path a browser takes.
    mounted.decline('booking.create')
    expect(mounted.page.declinedActionIds()).toContain('booking.create')
    mounted.page.destroy()
  })

  it('is not asked about the same action again', async () => {
    const mounted = mountPage()

    const first = await mounted.page.ask('book the garden twin room')
    const held = gated(first, 'booking.create')
    expect(held?.policy).toBe('confirmation_required')
    expect(held?.execution).toBe('not_attempted')

    mounted.decline('booking.create')
    expect(mounted.page.declinedActionIds()).toContain('booking.create')

    const again = await mounted.page.ask('book the garden twin room')
    const refused = gated(again, 'booking.create')

    // The defect: `confirmation_required` here means the visitor is asked the
    // same question they already answered. It has to be a denial, and it has to
    // name the refusal.
    expect(refused?.policy).toBe('denied')
    expect(refused?.denialReason).toBe('declined_by_visitor')
    expect(refused?.reason).toContain('declined earlier in this session')
    expect(refused?.execution).toBe('not_attempted')
    mounted.page.destroy()
  })

  it('never executes what it declined', async () => {
    const mounted = mountPage()
    const first = await mounted.page.ask('book the garden twin room')
    expect(gated(first, 'booking.create')?.policy).toBe('confirmation_required')

    // The panel as the page has it before anything runs: shut, and the only
    // thing that opens it is an action that draws. `booking.create` is not one —
    // no booking system is configured — so what a declined booking has to leave
    // behind is exactly this.
    const panelBefore = mounted.panel.textContent
    expect(mounted.panel.getAttribute('data-archava-panel')).toBe('closed')

    mounted.decline('booking.create')
    const again = await mounted.page.ask('book the garden twin room')
    const refused = gated(again, 'booking.create')

    // A declined action is a side effect that must not exist: no card, no panel,
    // and no claim that anything ran. The page is byte-for-byte what it was.
    expect(refused?.policy).toBe('denied')
    expect(refused?.execution).toBe('not_attempted')
    expect(refused?.idempotencyKey).toBeUndefined()
    expect(mounted.panel.textContent).toBe(panelBefore)
    expect(mounted.panel.getAttribute('data-archava-panel')).toBe('closed')
    mounted.page.destroy()
  })

  it('can change its mind, because a refusal that can never be lifted is not a refusal', async () => {
    const mounted = mountPage()
    const first = await mounted.page.ask('book the garden twin room')
    expect(gated(first, 'booking.create')?.policy).toBe('confirmation_required')

    mounted.decline('booking.create')
    const refused = await mounted.page.ask('book the garden twin room')
    const buried = gated(refused, 'booking.create')
    expect(buried?.denialReason).toBe('declined_by_visitor')

    // The gate owns the precedence rule — a confirmation in the same turn wins —
    // and the confirm button on the redrawn card is how the visitor gives it.
    mounted.confirm('booking.create')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const changed = await mounted.page.ask('book the garden twin room', ['booking.create'])
    const confirmed = gated(changed, 'booking.create')

    // The refusal is lifted, and what this assertion is really about is *which*
    // refusal. This turn still ends in `denied`, because §9 refuses a booking
    // with no `slotId`: the reference page sells no slots, and a resolver that
    // invented one so the test could assert `allowed` would be the §9 trap the
    // surface's own resolver refuses to walk into. What is gone is the visitor's
    // refusal — that verdict belongs to the gate alone, so its absence is what
    // proves the confirmation reached it.
    expect(confirmed?.execution).toBe('not_attempted')
    expect(confirmed?.denialReason).toBeUndefined()
    expect(confirmed?.reason).not.toContain('declined earlier in this session')
    expect(confirmed?.reason).toContain('slotId')

    // And the page still remembers the refusal, because a lifted refusal is not
    // a forgotten one: the gate wins this turn, the note outlives it.
    expect(mounted.page.declinedActionIds()).toContain('booking.create')
    mounted.page.destroy()
  })

  it('refuses only what was refused', async () => {
    const mounted = mountPage()
    const first = await mounted.page.ask('book the garden twin room')
    // The refusal is about one action. The others the same visitor may do stay
    // as they were, so a decline is not a ban on the rest of the session.
    mounted.decline('booking.create')
    const second = await mounted.page.ask('book the garden twin room')
    expect(gated(second, 'booking.create')?.denialReason).toBe('declined_by_visitor')
    expect(gated(first, 'booking.create')?.reason).toContain('Confirmation required')
    mounted.page.destroy()
  })
})
