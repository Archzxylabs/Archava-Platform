/**
 * The scout: the only part of the SDK that touches the DOM.
 *
 * PRD §24 says the SDK must "collect approved page context" and "synchronize
 * route/section/entity state". Those two verbs are the whole job. Everything
 * else in this file exists to keep the job honest:
 *
 * - It observes. It never mutates the host page. A scout that changes what the
 *   visitor sees has stopped being an observer, and an assistant's presence would
 *   corrupt the very context it is reading.
 * - It cannot read a form value. It reads `name` attributes off the inputs it
 *   already holds; `.value` is never fetched, which is why there is no masking
 *   step to forget.
 * - It has no clock of its own. `occurredAt` arrives as an argument, because a
 *   replay needs the times the events actually happened.
 */

import type { PageShape } from './page.js'
import { isValueBearing } from './page.js'
import { SdkEnvironmentError } from './errors.js'

/**
 * The selectors the scout reads, with the reason each one exists.
 *
 * A host that labels nothing can still opt in, and a host that labels everything
 * is the common case: these are the documented attributes, and a caller can pass
 * any selectors it likes.
 */
export interface ScoutSelectors {
  /** Entities currently visible. Default `[data-archava-entity]`. */
  readonly entity: string
  /** Actions the page is offering. Default `[data-archava-action]`. */
  readonly action: string
  /** The form the visitor is filling in. Default `form[data-archava-form]`. */
  readonly form: string
  /** Fields inside a form. Default `[name]`, scoped to the form. */
  readonly field: string
  /** Checkboxes that add an entity to a comparison. Default `[data-archava-compare]:checked`. */
  readonly comparison: string
  /** The currently active panel. Default `[data-archava-panel]:not([hidden])`. */
  readonly panel: string
  /** A visible error. Default `[role="alert"]`. */
  readonly error: string
  /** The section the visitor is reading. Default `[data-archava-section]`. */
  readonly section: string
}

export const DEFAULT_SELECTORS: ScoutSelectors = {
  entity: '[data-archava-entity]',
  action: '[data-archava-action]',
  form: 'form[data-archava-form]',
  field: '[name]',
  comparison: '[data-archava-compare]:checked',
  panel: '[data-archava-panel]:not([hidden])',
  error: '[role="alert"]',
  section: '[data-archava-section]',
}

/**
 * The shape of the DOM the scout needs.
 *
 * Structural, not `lib.dom`: it lets a host embed the SDK where there is no real
 * `window` (an SSR render, a worker, a test), and it means a page that omits a
 * member degrades to "nothing to read there" rather than crashing.
 */
export interface ScoutDocument {
  readonly location?: { readonly pathname?: string; readonly href?: string }
  readonly documentElement?: { readonly lang?: string }
  readonly querySelectorAll?: (selectors: string) => ScoutNodeList
}

/** A node list that can be indexed or walked; both shapes a DOM offers. */
export interface ScoutNodeList {
  readonly length: number
  item(index: number): ScoutNode | null
  readonly [index: number]: ScoutNode
}

/** A node as far as the scout looks — never deeper than an attribute or text. */
export interface ScoutNode {
  readonly tagName?: string
  readonly id?: string
  readonly textContent?: string | null
  readonly attributes?: ScoutNamedNodeMap | null
  readonly checked?: boolean
  readonly disabled?: boolean
  /**
   * Fields are read *scoped to their form*, so two forms on one page report two
   * name lists rather than one merged list. Declared here rather than cast at
   * the call site: the cast would keep a real part of the DOM out of the shape.
   */
  readonly querySelectorAll?: (selectors: string) => ScoutNodeList
}

export interface ScoutNamedNodeMap {
  readonly length: number
  getNamedItem(name: string): { readonly value: string } | null
  item(index: number): { readonly value: string } | null
  readonly [index: number]: { readonly value: string }
}

/** Everything the scout is allowed to derive from a DOM, in one read. */
export interface ScoutRead {
  readonly path: string
  readonly kind: string
  readonly locale: string
  readonly section?: string
  readonly entities: PageShape['entities']
  readonly actions: PageShape['actions']
  readonly errors: PageShape['errors']
  readonly form?: PageShape['form']
  readonly activePanel?: string
  readonly comparison?: PageShape['comparison']
}

/**
 * Read the page once.
 *
 * `now` is the host's timestamp: the scout has no `Date` access, so the error
 * times in the resulting graph are times a human actually saw — which is the only
 * kind that survives a replay.
 */
export function readDom(
  doc: ScoutDocument | null | undefined,
  now: string,
  selectors: ScoutSelectors = DEFAULT_SELECTORS,
): ScoutRead {
  if (doc === null || doc === undefined) {
    throw new SdkEnvironmentError('No document is available; page awareness requires a DOM.')
  }

  const entities = readEntities(doc.querySelectorAll?.(selectors.entity))
  const actions = readActions(doc.querySelectorAll?.(selectors.action))
  const errors = readErrors(doc.querySelectorAll?.(selectors.error), now)
  const form = readForm(doc, selectors)
  const comparison = readComparison(doc.querySelectorAll?.(selectors.comparison))
  const panel = readPanel(doc.querySelectorAll?.(selectors.panel))
  const section = readText(doc.querySelectorAll?.(selectors.section))

  return {
    path: pathOf(doc),
    // The graph needs a page *kind*, and the DOM does not say what kind of page
    // it is. The host sets it via `entities/kind` context, not here; `home` is
    // the honest default rather than a guess about routing.
    kind: 'home',
    locale: localeOf(doc),
    entities,
    actions,
    errors,
    ...(form === undefined ? {} : { form }),
    ...(comparison.entityIds.length > 0 ? { comparison } : {}),
    ...(panel === undefined ? {} : { activePanel: panel }),
    ...(section === undefined ? {} : { section }),
  }
}

function pathOf(doc: ScoutDocument): string {
  const path = doc.location?.pathname
  return path === undefined || path.length === 0 ? '/' : path
}

function localeOf(doc: ScoutDocument): string {
  return doc.documentElement?.lang ?? 'en'
}

/** Every visible entity: id and label. No value is read from an entity node. */
function readEntities(nodes: ScoutNodeList | undefined): PageShape['entities'] {
  return listOf(nodes).flatMap((node) => {
    const id = attribute(node, 'data-archava-entity') ?? node.id
    if (id === undefined || id.length === 0) return []
    // The accessible name first: an `aria-label` is the page *declaring* what the
    // entity is called, and a card's own text is a name, a summary and a run of
    // controls concatenated — the wrong answer to "what is this thing called".
    const label = attribute(node, 'aria-label') ?? readText(inline(node))
    return [{ id, name: label ?? id, kind: attribute(node, 'data-archava-kind') ?? 'unknown' }]
  })
}

/**
 * The actions the page is offering.
 *
 * `enabled` comes from `disabled` and `aria-disabled`. Note what this does *not*
 * mean: an enabled action attribute is not an action the assistant may take.
 * §18 still gates every request, and the gate fails closed on anything the page
 * did not list. This is the outer boundary telling the gate what exists; the gate
 * says what is permitted.
 */
function readActions(nodes: ScoutNodeList | undefined): PageShape['actions'] {
  return listOf(nodes).flatMap((node) => {
    const name = attribute(node, 'data-archava-action')
    if (name === undefined || name.length === 0) return []
    const aria = attribute(node, 'aria-disabled')
    return [{ name, enabled: node.disabled !== true && aria !== 'true' }]
  })
}

/** Visible errors, dated by the host's clock rather than the SDK's. */
function readErrors(nodes: ScoutNodeList | undefined, now: string): PageShape['errors'] {
  return listOf(nodes).map((node) => {
    const code = attribute(node, 'data-archava-error') ?? readText(inline(node)) ?? 'error'
    return { code, occurredAt: now }
  })
}

/**
 * The form's field *names*, grouped into completed, pending, and masked.
 *
 * A field counts as completed when its control reports selection state — a
 * checkbox that is ticked, a radio that is chosen. A text input is never counted
 * either way, because deciding "finished" would mean reading the value, and
 * reading the value is the thing §16 forbids. Those fields show up as pending,
 * which is the truthful answer: the SDK does not know.
 */
function readForm(doc: ScoutDocument, selectors: ScoutSelectors): PageShape['form'] | undefined {
  const form = listOf(doc.querySelectorAll?.(selectors.form))[0]
  if (form === undefined) return undefined

  const fields = listOf(fieldsOf(form, selectors.field))
  const completed: string[] = []
  const pending: string[] = []
  const masked: string[] = []

  for (const field of fields) {
    const name = attribute(field, 'name')
    if (name === undefined || name.length === 0) continue
    if (field.checked === true) {
      completed.push(name)
    } else {
      pending.push(name)
    }
    // A value-bearing name is masked even when its control reports "completed",
    // because completion of a password field is still an admission about it.
    if (isValueBearing(name)) {
      masked.push(name)
    }
  }

  const step = attribute(form, 'data-archava-step')
  return {
    id: attribute(form, 'data-archava-form') ?? form.id ?? 'form',
    completedFields: completed,
    pendingFields: pending,
    maskedFields: masked,
    ...(step === undefined ? {} : { step }),
  }
}

function fieldsOf(form: ScoutNode, selector: string): ScoutNodeList | undefined {
  if (selector.length === 0) return undefined
  return form.querySelectorAll?.(selector)
}

/** Entities a checkbox has added to the comparison, in visitor order. */
function readComparison(nodes: ScoutNodeList | undefined): { entityIds: string[] } {
  return {
    entityIds: listOf(nodes).flatMap((node) => {
      const id = attribute(node, 'data-archava-compare')
      return id === undefined || id.length === 0 ? [] : [id]
    }),
  }
}

function readPanel(nodes: ScoutNodeList | undefined): string | undefined {
  const panel = listOf(nodes)[0]
  if (panel === undefined) return undefined
  return attribute(panel, 'data-archava-panel') ?? panel.id ?? undefined
}

function readText(nodes: ScoutNodeList | undefined): string | undefined {
  const node = listOf(nodes)[0]
  if (node === undefined) return undefined
  const text = (node.textContent ?? '').trim()
  return text.length > 0 ? text : undefined
}

/** A node read as if it were a one-element list, so text helpers work on it. */
function inline(node: ScoutNode): ScoutNodeList {
  return {
    get length(): number {
      return 1
    },
    item: (index: number) => (index === 0 ? node : null),
    0: node,
  }
}

function attribute(node: ScoutNode, name: string): string | undefined {
  const value = node.attributes?.getNamedItem(name)?.value
  return value === undefined || value.length === 0 ? undefined : value
}

function listOf(nodes: ScoutNodeList | undefined): readonly ScoutNode[] {
  if (nodes === undefined || nodes === null) return []
  const out: ScoutNode[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item?.(index) ?? nodes[index]
    if (node !== null && node !== undefined) out.push(node)
  }
  return out
}
