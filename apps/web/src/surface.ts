/**
 * The tenant's page surface: what the reference page shows, and what the
 * assistant may do to it.
 *
 * The slice is only as honest as the page it is a slice of. A page that labels
 * nothing gives the SDK nothing to observe, and a turn that ran against an
 * empty graph is not a grounded turn — it is a decline wearing a graph's
 * clothes. This module is what makes the page a *page*: the four resources the
 * reference tenant sells, rendered where the scout will find them.
 *
 * Three things live here, and the split is the point:
 *
 * 1. **The markup** is a pure function of the tenant's units. Testing it needs
 *    no DOM at all, which is why it is a string and not a series of
 *    `createElement` calls — the contract worth pinning is "one entity element
 *    per unit, carrying the id and the kind", and a string asserts that plainly.
 * 2. **The resolver** answers "does this id exist on this page" for §9. It is
 *    the page's own memory of what it rendered, not a catalog: an id that
 *    exists for the tenant but is not on screen must resolve to `false`, because
 *    the visitor asked about a thing they are not looking at.
 * 3. **The executor** is the only code that changes what the visitor sees. It
 *    runs *after* the gate and *after* §9 validation, and it reports failure
 *    rather than half-doing a thing: an executor is a side effect, and a side
 *    effect that cannot be completed is a failed execution and not a success.
 *
 * What this module never does is decide whether an action may run. It carries
 * `data-archava-action` so the gate has a list to fail closed against, and it
 * does not consult that list itself — the gate owns it (§18).
 */
import type { ActionExecutionResult, ActionExecutor, EntityResolver } from '@archava/assistant'

/** A unit as the surface needs it: an id, a name, a kind, and a line of copy. */
export interface SurfaceUnit {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly summary: string
}

/** How many entities a comparison on this page will put side by side. */
export const MAX_COMPARED = 4

/** Escape a value so it can sit inside markup as text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Escape a value so it can sit inside a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;')
}

/**
 * The markup for the whole surface, as one string.
 *
 * The attributes matter more than the prose, and each one is here because a
 * named reader reads it:
 *
 * - `data-archava-section` on the heading — the scout reports the section the
 *   visitor is reading, and this is the only element carrying it, so the first
 *   match is the whole answer.
 * - `data-archava-entity` + `data-archava-kind` on each card — one visible
 *   entity per unit. Without the kind the scout reports `unknown`, and a turn
 *   grounded on `unknown` entities is grounded on nothing useful.
 * - `aria-label` on each card — the label the scout reads. A card's own text is
 *   its name, its summary, and its controls in one run together, which is the
 *   wrong answer to "what is this thing called", so the attribute is what names
 *   it and the text is a fallback the page does not need to rely on.
 * - `data-archava-compare` on each checkbox — the selection. Checked, it lands
 *   in `graph.comparison.entityIds`, which is the graph's only "which of these
 *   am I choosing" signal.
 * - `data-archava-action` on the controls — the page's declared offer. The gate
 *   treats this list as authoritative: an action the page did not list is
 *   denied before capability is ever weighed, which is why the list holds the
 *   ids this page can actually carry out (`ui.compare`, `ui.highlight`,
 *   `booking.create`) plus the navigation the page's own nav performs.
 * - `data-archava-panel` on the single panel — the current panel. `hidden`
 *   while nothing is open, so the scout reports no panel rather than a stale
 *   one; the executor reveals it and rewrites the value.
 *
 * `payment.initiate` is deliberately absent. The reference tenant runs at the
 * `act` tier and that action needs `transact`, so a page that declared it would
 * be offering something no visitor could ever be allowed to have — and the
 * denial worth seeing is `capability_insufficient`, which is only reachable by
 * asking for something the page did not list.
 */
export function surfaceMarkup(units: readonly SurfaceUnit[]): string {
  const cards = units
    .map(
      (
        unit,
      ) => `      <article class="card" id="unit-${escapeAttribute(unit.id)}" aria-label="${escapeAttribute(unit.name)}" data-archava-entity="${escapeAttribute(unit.id)}" data-archava-kind="${escapeAttribute(unit.kind)}">
        <h3>${escapeHtml(unit.name)}</h3>
        <p class="summary">${escapeHtml(unit.summary)}</p>
        <div class="card-controls">
          <label class="tick"><input type="checkbox" data-archava-compare="${escapeAttribute(unit.id)}" /> <span>Compare</span></label>
          <button type="button" class="show" data-archava-action="ui.highlight" data-ask="show me the ${escapeAttribute(unit.name)}">Show me</button>
        </div>
      </article>`,
    )
    .join('\n')

  return `    <section id="surface" aria-labelledby="surface-heading">
      <h2 id="surface-heading" data-archava-section>Rooms</h2>
      <p class="lede">
        Four resources this page is showing you. Tick two, or point at one —
        the assistant will ask for exactly that, and the pipeline will decide
        whether it may.
      </p>
      <div class="toolbar" role="group" aria-label="What you can ask Archava to do">
        <button type="button" data-archava-action="ui.compare" data-ask="compare the rooms I selected">Compare</button>
        <button type="button" data-archava-action="booking.create" data-ask="reserve a room">Reserve</button>
      </div>
      <div class="cards" id="cards">
${cards}
      </div>
      <div class="panel" id="panel" data-archava-panel="closed" hidden></div>
    </section>`
}

/** The entity ids the surface rendered, in the order it rendered them. */
export function surfaceEntityIds(units: readonly SurfaceUnit[]): readonly string[] {
  return units.map((unit) => unit.id)
}

/**
 * A resolver that answers from the page rather than from the tenant.
 *
 * The important half is what it says `no` to. A slot, a customer, a template —
 * none of those are page entities, and a resolver that answered `true` for
 * them because "the tenant has slots" would be the §9 trap exactly: a schema
 * says a `slotId` is a string, and only an authoritative source says whether
 * the slot exists. Here the authoritative source is this page.
 *
 * An unknown id resolves to `false` rather than throwing, because an
 * unreachable catalog is not permission to guess.
 */
export function pageEntityResolver(ids: readonly string[]): EntityResolver {
  const rendered = new Set(ids)
  return {
    resolveExists: (_tenantId, entityKind, entityId): Promise<boolean> =>
      Promise.resolve(
        entityKind === 'pageEntity' && typeof entityId === 'string' && rendered.has(entityId),
      ),
  }
}

/** The units being compared, in the order the request named them. */
export function comparisonMarkup(ids: readonly string[], units: readonly SurfaceUnit[]): string {
  const rows = units.filter((unit) => ids.includes(unit.id))
  if (rows.length < 2) {
    return `      <p class="panel-note">A comparison needs two things on this page, and only ${rows.length} were found.</p>`
  }
  const body = rows
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${escapeHtml(row.summary)}</td></tr>`,
    )
    .join('')
  return `      <table class="comparison">
        <caption>Comparison</caption>
        <thead><tr><th scope="col">Resource</th><th scope="col">Summary</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="panel-note">Comparing ${rows.length} resources.</p>`
}

/**
 * The elements of the page the executor needs, and nothing else.
 *
 * Structural rather than `lib.dom` for the same reason the scout's is: it keeps
 * the executor runnable against anything that can hold a panel, and it means a
 * host cannot accidentally hand it a whole document to write into.
 *
 * `innerHTML` and `hidden` are plain mutable properties rather than a getter and
 * a setter each, because an interface member named twice is a declaration the
 * compiler refuses — and because the executor both reads and writes both of
 * them, so a read-only declaration would be a promise the type cannot keep.
 */
export interface SurfaceElement {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  innerHTML: string
  hidden: boolean
  classList: { add(name: string): void; remove(name: string): void }
  scrollIntoView?(options?: { behavior?: string; block?: string }): void
  querySelector?(selector: string): SurfaceElement | null
  textContent?: string | null
}

/** The document slice the executor is allowed to touch. */
export interface SurfaceDocument {
  querySelector(selector: string): SurfaceElement | null
  querySelectorAll?(selector: string): readonly SurfaceElement[]
}

/**
 * The reference page's executor: it draws on the page, and nothing else.
 *
 * It is a `ui.*` executor and nothing more. A booking, a payment, an order —
 * none of those are things a browser may perform on a tenant's behalf, so this
 * executor reports them as failures rather than pretending. That is the honest
 * shape of a reference slice: the pipeline's decisions are all visible, and the
 * one place a real system would sit is left empty and labelled.
 *
 * Supplying no executor at all would also produce `not_attempted`, and that is
 * what the slice should do for anything it has no page for. This one exists so
 * the L1 UI path can be *seen* to work end to end in a browser — the gate
 * allows, validation verifies, this draws, and the graph the SDK reads next
 * reflects it.
 */
export function pageExecutor(document: SurfaceDocument): ActionExecutor {
  return {
    executorId: 'archava-reference-page',
    // The page's work is synchronous — a DOM write is a DOM write — but the port
    // is a promise, so the result is wrapped rather than the work made to look
    // slower than it is.
    execute: (request) => Promise.resolve(executeOnPage(request.action, request.inputs, document)),
  }
}

function executeOnPage(
  action: string,
  inputs: Readonly<Record<string, unknown>>,
  document: SurfaceDocument,
): ActionExecutionResult {
  if (action === 'ui.highlight') return highlightEntity(inputs, document)
  if (action === 'ui.compare') return compareEntities(inputs, document)
  return failure(
    'not_a_page_action',
    'This page can only draw on itself; a browser may not perform that action.',
  )
}

/** Scroll to one entity and say so on the page. */
function highlightEntity(
  inputs: Readonly<Record<string, unknown>>,
  document: SurfaceDocument,
): ActionExecutionResult {
  const entityId = inputs.entityId
  if (typeof entityId !== 'string') {
    return failure('highlight_target_missing', 'No entity id was supplied to highlight.')
  }

  const target = findEntity(document, entityId)
  if (target === null) {
    return failure(
      'entity_not_on_page',
      'That entity is not on this page, so there is nothing to highlight.',
    )
  }

  const panel = document.querySelector('#panel')
  if (panel !== null) {
    openPanel(
      panel,
      `unit:${entityId}`,
      `      <p class="panel-note">Highlighted ${escapeHtml(readName(target, entityId))}.</p>`,
    )
  }
  target.classList.add('is-highlighted')
  target.setAttribute('data-archava-current', 'true')
  target.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  return { status: 'succeeded', output: { entityId, panel: `unit:${entityId}` } }
}

/** Open the comparison view over the entities the request named. */
function compareEntities(
  inputs: Readonly<Record<string, unknown>>,
  document: SurfaceDocument,
): ActionExecutionResult {
  const requested = inputs.entityIds
  if (!Array.isArray(requested)) {
    return failure('comparison_targets_missing', 'No entities were supplied to compare.')
  }

  const ids = requested.filter((id): id is string => typeof id === 'string')
  const onPage = unitsOn(document).filter((unit) => ids.includes(unit.id))
  if (onPage.length < 2) {
    return failure(
      'comparison_needs_two',
      'A comparison needs two things on this page, and fewer than two were found.',
    )
  }

  const panel = document.querySelector('#panel')
  if (panel === null) {
    return failure('panel_missing', 'This page has nowhere to draw a comparison.')
  }

  openPanel(
    panel,
    'comparison',
    comparisonMarkup(
      ids,
      onPage.map((unit) => ({
        id: unit.id,
        name: unit.name,
        kind: unit.kind,
        summary: readSummary(unit.element),
      })),
    ),
  )
  return { status: 'succeeded', output: { entityIds: ids, panel: 'comparison' } }
}

/** Reveal the one panel, and stamp what is now showing in it. */
function openPanel(panel: SurfaceElement, name: string, markup: string): void {
  panel.setAttribute('data-archava-panel', name)
  panel.innerHTML = markup
  panel.hidden = false
}

/** The element an id names, or `null` when the page is not showing it. */
function findEntity(document: SurfaceDocument, entityId: string): SurfaceElement | null {
  return unitsOn(document).find((unit) => unit.id === entityId)?.element ?? null
}

/** A unit the page is showing, and the element it is showing it in. */
interface RenderedUnit {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly element: SurfaceElement
}

/** Every rendered unit, in document order. */
function unitsOn(document: SurfaceDocument): readonly RenderedUnit[] {
  const rendered: RenderedUnit[] = []
  for (const element of allEntities(document)) {
    const id = element.getAttribute('data-archava-entity')
    if (id === null || id === '') continue
    rendered.push({
      id,
      name: readName(element, id),
      kind: element.getAttribute('data-archava-kind') ?? 'unknown',
      element,
    })
  }
  return rendered
}

function allEntities(document: SurfaceDocument): readonly SurfaceElement[] {
  // A structural document may have no way to list children; an executor that
  // cannot see the page cannot act on it, and says so by finding nothing.
  return document.querySelectorAll?.('[data-archava-entity]') ?? []
}

/** The name the scout would read: the heading first, then the id. */
function readName(element: SurfaceElement, id: string): string {
  const heading = element.querySelector?.('h3')
  const text = heading?.textContent?.trim()
  return text !== undefined && text.length > 0 ? text : id
}

function readSummary(element: SurfaceElement): string {
  return element.querySelector?.('.summary')?.textContent?.trim() ?? ''
}

function failure(errorCode: string, message: string): ActionExecutionResult {
  return { status: 'failed', errorCode, retryable: false, message }
}
