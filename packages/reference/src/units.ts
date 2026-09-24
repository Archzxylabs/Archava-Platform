/**
 * The units the reference tenant sells, as config input.
 *
 * These literals are the input the client config parses; the parsed form is
 * `referenceUnits` in `tenant.ts`. Keeping the raw literal here (rather than
 * reading the units back and restating them) means a unit exists exactly once
 * in the codebase.
 *
 * The projection to context-graph refs lives here too, because that is where
 * page awareness will need it: PRD §16 has the SDK's `entities` carry the id,
 * the label, and the kind the visitor is looking at, and the kind in the graph
 * is the *kind the page says it is* — not the closed enum a config validates
 * against. The two are related but not the same thing, and conflating them
 * would let the demo teach the assistant a vocabulary its pages do not use.
 */
import type { ClientConfig, Entity } from '@archava/config'

/** Hotel rooms and villas, in the order the catalog lists them. */
export const referenceUnitInputs = [
  {
    id: 'garden-twin',
    kind: 'resource',
    name: 'Garden Twin Room',
    summary: 'Two single beds opening onto the lower garden wing.',
    attributes: { guests: 2, sizeSqm: 28, bed: 'twin', view: 'garden' },
    visible: true,
  },
  {
    id: 'deluxe-valley',
    kind: 'resource',
    name: 'Deluxe Valley Room',
    summary: 'King bed with a private balcony over the rice terraces.',
    attributes: { guests: 2, sizeSqm: 34, bed: 'king', view: 'valley', balcony: true },
    visible: true,
  },
  {
    id: 'treetop-suite',
    kind: 'resource',
    name: 'Treetop Suite',
    summary: 'Split-level suite on the canopy walk, with an outdoor bath.',
    attributes: {
      guests: 3,
      sizeSqm: 52,
      bed: 'king-plus-sofa',
      view: 'canopy',
      outdoorBath: true,
    },
    visible: true,
  },
  {
    id: 'valley-pool-villa',
    kind: 'resource',
    name: 'Valley Pool Villa',
    summary: 'Standalone villa with a heated pool and a reading pavilion.',
    attributes: { guests: 4, sizeSqm: 68, pool: true, bed: 'king', view: 'valley' },
    visible: true,
  },
] as const satisfies readonly Entity[]

/** The context-graph shape the SDK puts on the page (PRD §16). */
export interface UnitRef {
  readonly id: string
  readonly name: string
  readonly kind: string
}

/**
 * Project config entities into context refs.
 *
 * Only visible units are projected. A unit the tenant has hidden is still
 * priced and still bookable by staff, but an assistant that lists it on a page
 * is answering from a page the visitor cannot see.
 */
export function toUnitRefs(units: readonly Entity[]): readonly UnitRef[] {
  return units
    .filter((unit) => unit.visible)
    .map((unit) => ({ id: unit.id, name: unit.name, kind: unit.kind }))
}

/** The same refs, keyed by id, for a page that shows one unit. */
export function unitRefIndex(units: readonly Entity[]): Readonly<Record<string, UnitRef>> {
  return Object.fromEntries(toUnitRefs(units).map((ref) => [ref.id, ref]))
}

/** The id of the units a listing page would put on the graph. */
export function unitIdsFor(units: readonly Entity[]): readonly string[] {
  return toUnitRefs(units).map((ref) => ref.id)
}

/** The kind the page should declare for a unit, in the vocabulary of the config. */
export function kindOf(units: readonly Entity[], unitId: string): string | undefined {
  return units.find((unit) => unit.id === unitId)?.kind
}

/** Narrows a config to the tenant's own, so a helper cannot be handed a foreign one. */
export function isReferenceTenant(config: ClientConfig): boolean {
  return config.isReferenceImplementation === true
}
