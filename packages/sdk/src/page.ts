/**
 * Reading a host page as a series of context events.
 *
 * PRD §16 names what page awareness is: route, section, visible entities,
 * selected item, comparison state, form state, cart state, checkout step,
 * authenticated customer context, known UI errors, active panel, available
 * actions. Every one of those is a *shape the page already has*, so the work
 * here is translation, not inference.
 *
 * Three rules govern the translation, and each exists because the alternative
 * is a way to be subtly wrong:
 *
 * 1. **Names, never values.** A form contributes `completedFields`,
 *    `pendingFields`, and `maskedFields` — all field *names*. The graph has
 *    nowhere to put a value, so §16's masking boundary is enforced by the shape
 *    itself rather than by remembering to drop a field.
 * 2. **Only differences are emitted.** An SDK that re-emits every event on every
 *    mutation makes the event log useless as a history, and a history is what
 *    lets a turn be replayed.
 * 3. **The page can only narrow.** Emitted actions carry the page's own
 *    `enabled` flag verbatim; nothing here invents an enabled action, because
 *    §18 makes the client allow-list the outer boundary and the policy gate the
 *    inner one.
 */

import type { ContextEvent, ContextForm } from '@archava/core'

/** One visible entity, as the host page presents it. */
export interface PageEntity {
  readonly id: string
  readonly name: string
  readonly kind: string
}

/** One action the page is currently offering. */
export interface PageAction {
  readonly name: string
  readonly enabled: boolean
}

/** One UI error the host has recorded and surfaced. */
export interface PageError {
  readonly code: string
  readonly occurredAt: string
}

/** Form state, reduced to the parts the graph carries. */
export interface PageForm {
  readonly id: string
  readonly step?: string
  readonly completedFields: readonly string[]
  readonly pendingFields: readonly string[]
  /** Field names the host itself declared sensitive (§16). */
  readonly maskedFields: readonly string[]
}

/**
 * The shape of a page, in the only vocabulary the graph understands.
 *
 * Deliberately plain data: the same shape can be read from a DOM, synthesised by
 * a host application that knows its own state, or handed to a test.
 */
export interface PageShape {
  readonly path: string
  readonly kind: string
  readonly locale: string
  readonly section?: string
  readonly entities: readonly PageEntity[]
  readonly actions: readonly PageAction[]
  readonly errors: readonly PageError[]
  readonly form?: PageForm
  readonly activePanel?: string
  readonly comparison?: {
    readonly entityIds: readonly string[]
    readonly metric?: string
  }
}

/**
 * Field names that plausibly hold something a visitor typed.
 *
 * This list is how a host that forgot to label its own password field still
 * gets it masked. It matches by name because the SDK holds names only — it
 * cannot mask a value it never received.
 */
export const VALUE_BEARING_FIELD_NAMES: readonly string[] = [
  'password',
  'passphrase',
  'secret',
  'token',
  'otp',
  'pin',
  'cvv',
  'cardnumber',
  'card',
  'expiry',
  'cvc',
  'iban',
  'taxid',
  'passport',
  'nationalid',
  'ssn',
]

/** True when a field name is one the SDK refuses to treat as ordinary content. */
export function isValueBearing(name: string): boolean {
  const lowered = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return VALUE_BEARING_FIELD_NAMES.some((candidate) => lowered.includes(candidate))
}

/** The events that describe a page the SDK has never seen before. */
export function readPage(page: PageShape): readonly ContextEvent[] {
  return reconcilePage(null, page)
}

/**
 * The events that move a graph from `previous` to `next`.
 *
 * Returns nothing when the two describe the same page. That is the case worth
 * optimising: a real site fires mutations constantly (analytics beacons, lazy
 * images, a clock in the header), and a history that replayed each of them would
 * bury the one that mattered.
 */
export function reconcilePage(
  previous: PageShape | null,
  next: PageShape,
): readonly ContextEvent[] {
  // A first observation needs a full description, or the graph would start empty
  // and only partially describe the page it is on.
  if (previous === null) {
    return describe(next)
  }

  const events: ContextEvent[] = []

  if (previous.path !== next.path) {
    events.push({ type: 'page/route', route: next.path, kind: next.kind })
  }
  if (previous.locale !== next.locale) {
    events.push({ type: 'page/locale', locale: next.locale })
  }
  if (previous.section !== next.section) {
    events.push({ type: 'page/section', section: next.section ?? next.path })
  }
  if (sameEntities(previous.entities, next.entities) === false) {
    events.push({ type: 'entities/set', entities: [...next.entities] })
  }
  if (sameActions(previous.actions, next.actions) === false) {
    events.push({ type: 'action/set', actions: [...next.actions] })
  }
  if (sameErrors(previous.errors, next.errors) === false) {
    // Report the errors that *appeared*, so a history shows one error once.
    const appeared = next.errors.filter((error) => sameErrors([error], previous.errors) === false)
    if (appeared.length > 0) {
      appeared.forEach((error) => events.push({ ...error, type: 'error/recorded' }))
    } else {
      events.push({ type: 'error/cleared' })
    }
  }
  if (sameForm(previous.form, next.form) === false) {
    events.push({ type: 'form/set', form: next.form === undefined ? null : maskForm(next.form) })
  }
  if (sameComparison(previous.comparison, next.comparison) === false) {
    events.push({
      type: 'comparison/set',
      entityIds: [...(next.comparison?.entityIds ?? [])],
    })
  }
  if (previous.activePanel !== next.activePanel) {
    events.push({ type: 'page/activePanel', panel: next.activePanel ?? null })
  }

  return events
}

/**
 * Every event a page the SDK has never seen needs.
 *
 * Kept out of `reconcilePage`'s first branch because a literal spread cannot be
 * contextually typed: each entry is pushed instead, so `type` stays a member of
 * the `ContextEvent` union rather than widening to `string`.
 */
function describe(page: PageShape): readonly ContextEvent[] {
  const events: ContextEvent[] = [
    { type: 'page/route', route: page.path, kind: page.kind },
    { type: 'page/locale', locale: page.locale },
  ]
  if (page.section !== undefined) {
    events.push({ type: 'page/section', section: page.section })
  }
  events.push({ type: 'entities/set', entities: [...page.entities] })
  if (page.comparison !== undefined) {
    events.push({
      type: 'comparison/set',
      entityIds: [...page.comparison.entityIds],
      ...(page.comparison.metric === undefined ? {} : { metric: page.comparison.metric }),
    })
  }
  if (page.form !== undefined) {
    events.push({ type: 'form/set', form: maskForm(page.form) })
  }
  events.push({ type: 'action/set', actions: [...page.actions] })
  events.push({ type: 'page/activePanel', panel: page.activePanel ?? null })
  for (const error of page.errors) {
    events.push({ type: 'error/recorded', code: error.code, occurredAt: error.occurredAt })
  }
  return events
}

/**
 * Which of `fields` must be withheld from a provider.
 *
 * A name is withheld when the host declared it sensitive *or* when it is one the
 * SDK treats as value-bearing by default. The union is what makes "the host
 * forgot to label its password field" safe: the default list catches it anyway.
 */
export function maskedFieldNames(
  fields: readonly string[],
  hostDeclared: readonly string[] = [],
): readonly string[] {
  return fields.filter((name) => hostDeclared.includes(name) || isValueBearing(name))
}

/**
 * The form as the graph stores it: field names, with the sensitive ones flagged.
 *
 * Returns `ContextForm` rather than `PageForm` because the two differ in
 * mutability, and an event is what the reducer holds. The names are the same
 * names either way; the graph simply requires its own arrays.
 */
function maskForm(form: PageForm): ContextForm {
  const known = [...form.completedFields, ...form.pendingFields, ...form.maskedFields]
  return {
    id: form.id,
    completedFields: [...form.completedFields],
    pendingFields: [...form.pendingFields],
    maskedFields: [...maskedFieldNames(known, form.maskedFields)],
    ...(form.step === undefined ? {} : { step: form.step }),
  }
}

/** A stable string for a list of names, for change detection only. */
function fingerprint(names: readonly string[]): string {
  return names.join(' ')
}

function sameEntities(left: readonly PageEntity[], right: readonly PageEntity[]): boolean {
  return (
    left.length === right.length &&
    left.every((entity, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        entity.id === other.id &&
        entity.name === other.name &&
        entity.kind === other.kind
      )
    })
  )
}

function sameActions(left: readonly PageAction[], right: readonly PageAction[]): boolean {
  return (
    left.length === right.length &&
    left.every((action, index) => {
      const other = right[index]
      return other !== undefined && action.name === other.name && action.enabled === other.enabled
    })
  )
}

function sameErrors(left: readonly PageError[], right: readonly PageError[]): boolean {
  return (
    left.length === right.length &&
    left.every((error, index) => {
      const other = right[index]
      return other !== undefined && error.code === other.code && error.occurredAt === other.occurredAt
    })
  )
}

function sameForm(left: PageForm | undefined, right: PageForm | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.id === right.id &&
    (left.step ?? null) === (right.step ?? null) &&
    fingerprint(left.completedFields) === fingerprint(right.completedFields) &&
    fingerprint(left.pendingFields) === fingerprint(right.pendingFields) &&
    fingerprint(left.maskedFields) === fingerprint(right.maskedFields)
  )
}

function sameComparison(
  left: PageShape['comparison'],
  right: PageShape['comparison'],
): boolean {
  return (
    (left?.entityIds ?? []).join(' ') === (right?.entityIds ?? []).join(' ') &&
    (left?.metric ?? null) === (right?.metric ?? null)
  )
}
