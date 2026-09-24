/**
 * Generative UI, constrained to a registry (PRD §25).
 *
 * The rule is one sentence: "Model output selects from a validated registry and
 * supplies validated props. It does not execute arbitrary client-side code."
 *
 * Everything here exists to make that sentence structurally true rather than
 * merely intended:
 *
 * - The component kinds are a closed union. A model cannot invent a kind; an
 *   unknown one fails validation.
 * - Each kind has its own prop schema. A `comparison_table` cannot be handed a
 *   `recommendation_list`'s props.
 * - Rendering stays elsewhere. This module validates and returns a plain data
 *   tree; nothing in it can draw, import, or evaluate anything.
 */

import { z } from 'zod'

/** Closed set of things the assistant may draw. */
export const GENERATIVE_COMPONENT_KINDS = [
  'recommendation_list',
  'comparison_table',
  'booking_picker',
  'product_shortlist',
  'order_summary',
  'faq_source_card',
  'cta',
  'human_handoff_card',
] as const
export type GenerativeComponentKind = (typeof GENERATIVE_COMPONENT_KINDS)[number]

/** Lifecycle steps a summary may report on (PRD §19). */
export const TRANSACTION_STAGES = [
  'discovery',
  'selection',
  'cart',
  'checkout',
  'payment_pending',
  'payment_confirmed',
  'confirmation_sent',
  'fulfillment',
  'support',
] as const
export type TransactionStage = (typeof TRANSACTION_STAGES)[number]

/** A recommendation is an entity the visitor was shown, with why. */
const recommendationItemSchema = z.object({
  entityId: z.string().min(1),
  entityName: z.string().min(1),
  /** Why this was recommended; authored from grounded content, never invented. */
  reason: z.string().min(1),
  /** Knowledge chunk the reason rests on, when there is one (§17 provenance). */
  sourceId: z.string().min(1).nullable(),
})

export const recommendationListPropsSchema = z.object({
  items: z.array(recommendationItemSchema).min(1),
})

/** A comparison is entities × metrics. Cells are ids and labels, never secrets. */
export const comparisonTablePropsSchema = z.object({
  entityIds: z.array(z.string().min(1)).min(2),
  metrics: z.array(z.string().min(1)).min(1),
})

export const bookingPickerPropsSchema = z.object({
  subjectId: z.string().min(1),
  subjectName: z.string().min(1),
  /** ISO date/time strings the authoritative system offered, never invented. */
  slots: z.array(z.string().min(1)).min(1),
})

export const productShortlistPropsSchema = z.object({
  entityIds: z.array(z.string().min(1)).min(1),
})

export const orderSummaryPropsSchema = z.object({
  orderId: z.string().min(1),
  /** Total in minor units, paired with its currency so it can never be bare. */
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  stage: z.enum(TRANSACTION_STAGES),
})

/**
 * A source card is the provenance surface: it shows the chunk an answer rested
 * on so the visitor can see it came from the tenant's own content (§17).
 */
export const faqSourceCardPropsSchema = z.object({
  sourceId: z.string().min(1),
  sourceTitle: z.string().min(1),
  excerpt: z.string().min(1),
})

export const ctaPropsSchema = z.object({
  label: z.string().min(1),
  /** An action id already allowed by the policy gate (§18). */
  actionId: z.string().min(1),
})

export const humanHandoffCardPropsSchema = z.object({
  reason: z.string().min(1),
  /** True when the handoff is already in flight, so the card offers no retry. */
  requested: z.boolean(),
})

export const GENERATIVE_PROP_SCHEMAS = {
  recommendation_list: recommendationListPropsSchema,
  comparison_table: comparisonTablePropsSchema,
  booking_picker: bookingPickerPropsSchema,
  product_shortlist: productShortlistPropsSchema,
  order_summary: orderSummaryPropsSchema,
  faq_source_card: faqSourceCardPropsSchema,
  cta: ctaPropsSchema,
  human_handoff_card: humanHandoffCardPropsSchema,
} as const satisfies Record<GenerativeComponentKind, z.ZodTypeAny>

export type GenerativeProps = {
  [Kind in GenerativeComponentKind]: z.infer<(typeof GENERATIVE_PROP_SCHEMAS)[Kind]>
}

/** One validated component: a known kind, and props that kind accepts. */
export type GenerativeComponent = {
  [Kind in GenerativeComponentKind]: { readonly kind: Kind; readonly props: GenerativeProps[Kind] }
}[GenerativeComponentKind]

export class GenerativeUIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerativeUIError'
  }
}

/**
 * Build a component from an unvalidated model payload.
 *
 * Throws on an unknown kind or bad props. That is the whole point: the failure is
 * loud and the component is never produced, rather than a malformed component
 * reaching a renderer that has to guess.
 */
export function buildComponent(input: unknown): GenerativeComponent {
  const parsed = z
    .object({
      kind: z.enum(GENERATIVE_COMPONENT_KINDS),
      props: z.record(z.string(), z.unknown()),
    })
    .safeParse(input)

  if (!parsed.success) {
    throw new GenerativeUIError(
      `A generative component needs a known kind and props; got ${JSON.stringify(input)}.`,
    )
  }

  const { kind, props } = parsed.data
  const result = GENERATIVE_PROP_SCHEMAS[kind].safeParse(props)

  if (!result.success) {
    throw new GenerativeUIError(
      `Props for "${kind}" are invalid: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
    )
  }

  return { kind, props: result.data } as GenerativeComponent
}

/**
 * Validate a list, keeping the ones that pass and reporting the rest.
 *
 * A turn with eight requested components should not die because one had a bad
 * prop; but it must not silently drop it either, because a recommendation the
 * visitor never saw is a broken promise. Both halves are returned.
 */
export function buildComponents(inputs: readonly unknown[]): {
  readonly components: readonly GenerativeComponent[]
  readonly rejected: readonly string[]
} {
  const components: GenerativeComponent[] = []
  const rejected: string[] = []

  for (const input of inputs) {
    try {
      components.push(buildComponent(input))
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : String(error))
    }
  }

  return { components, rejected }
}

/**
 * Keep only components whose `actionId` the policy gate actually allowed.
 *
 * PRD §18: page context can only narrow what a capability permits, never widen
 * it. A CTA the model drew is not permission to run its action, so the CTA is
 * filtered against the allowed set before it can be displayed.
 */
export function filterComponentsByAllowedActions(
  components: readonly GenerativeComponent[],
  allowedActionIds: readonly string[],
): readonly GenerativeComponent[] {
  const allowed = new Set(allowedActionIds)

  return components.filter((component) => {
    if (component.kind !== 'cta') {
      return true
    }
    return allowed.has(component.props.actionId)
  })
}
