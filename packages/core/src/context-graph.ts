import { z } from 'zod'
import type { ClientConfig } from '@archava/config'

/**
 * Page-awareness Context Graph (PRD.md §16).
 *
 * The graph is a *pure* value: it is built only by applying the reducer below
 * to a seed derived from the client config, plus context events emitted by the
 * Archava SDK on the host page. There is no hidden ambient state, which keeps
 * the whole thing serialisable, testable, and tenant-scoped.
 *
 * The primary source of truth is structured SDK/DOM/application state. Vision
 * is an optional enrichment layer and is never modelled here as authoritative.
 */

export const contextPageSchema = z.object({
  /** Absolute path of the current route, e.g. `/rooms`. */
  route: z.string().min(1),
  /** Human page kind derived from the route/template page vocabulary. */
  kind: z.string().min(1),
  /** Stable identifier for the current section within the page. */
  section: z.string().optional(),
  locale: z.string().min(1),
})

export const contextEntityRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** `product` | `service` | `resource` | `offer` | `location` */
  kind: z.string().min(1),
})

export const contextComparisonSchema = z.object({
  entityIds: z.array(z.string().min(1)).default([]),
  metric: z.string().optional(),
})

export const contextFormSchema = z.object({
  /** Schema-stable form identifier, e.g. `booking_request`. */
  id: z.string().min(1),
  step: z.string().optional(),
  completedFields: z.array(z.string().min(1)).default([]),
  /** Never a value from the client: field *names* only. */
  pendingFields: z.array(z.string().min(1)).default([]),
  /** Fields present in the form that must not reach the model. */
  maskedFields: z.array(z.string().min(1)).default([]),
})

export const contextCartSchema = z.object({
  currency: z.string().length(3).optional(),
  lineCount: z.number().int().nonnegative(),
  /** Subtotal is authoritative only when the host supplies it. */
  subtotal: z.number().nonnegative().optional(),
})

export const contextCheckoutSchema = z.object({
  step: z.string().min(1),
  /** Ordinal + total, e.g. `{ index: 1, total: 3 }`. */
  index: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
})

export const contextSessionSchema = z.object({
  /** True only when the host page has authenticated the visitor. */
  authenticated: z.boolean(),
  role: z.string().optional(),
  /** Opaque, host-supplied identifier. Never contains profile data. */
  customerRef: z.string().optional(),
})

export const contextErrorSchema = z.object({
  /** Snapshot-stable message, e.g. `booking_slot_unavailable`. */
  code: z.string().min(1),
  occurredAt: z.string().min(1),
})

export const contextActionAvailabilitySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
})

export const contextGraphSchema = z.object({
  tenantId: z.string().min(1),
  page: contextPageSchema,
  entities: z.array(contextEntityRefSchema).default([]),
  comparison: contextComparisonSchema.optional(),
  form: contextFormSchema.optional(),
  cart: contextCartSchema.optional(),
  checkout: contextCheckoutSchema.optional(),
  session: contextSessionSchema,
  availableActions: z.array(contextActionAvailabilitySchema).default([]),
  errors: z.array(contextErrorSchema).default([]),
  activePanel: z.string().optional(),
})

export type ContextGraph = z.infer<typeof contextGraphSchema>
export type ContextPage = z.infer<typeof contextPageSchema>
export type ContextForm = z.infer<typeof contextFormSchema>
export type ContextError = z.infer<typeof contextErrorSchema>

/**
 * Context events. Every mutation to the graph is one of these, so the graph is
 * fully replayable from (seed + event list) — which is what the tests and the
 * assistant's turn-scoped snapshots rely on.
 */
export type ContextEvent =
  | { type: 'page/route'; route: string; kind?: string }
  | { type: 'page/section'; section: string }
  | { type: 'page/locale'; locale: string }
  | { type: 'page/activePanel'; panel: string | null }
  | { type: 'entities/set'; entities: ContextGraph['entities'] }
  | { type: 'entities/select'; entityId: string }
  | { type: 'entities/deselect' }
  | { type: 'comparison/set'; entityIds: string[]; metric?: string }
  | { type: 'form/set'; form: ContextForm | null }
  | { type: 'form/fieldCompleted'; field: string }
  | { type: 'cart/set'; cart: NonNullable<ContextGraph['cart']> | null }
  | { type: 'checkout/step'; step: string; index?: number; total?: number }
  | { type: 'session/authenticated'; role?: string; customerRef?: string }
  | { type: 'session/anonymous' }
  | { type: 'action/set'; actions: ContextGraph['availableActions'] }
  | { type: 'action/enabled'; name: string; enabled: boolean }
  | { type: 'error/recorded'; code: string; occurredAt: string }
  | { type: 'error/cleared' }

function replace<T>(list: readonly T[], value: T): T[] {
  const index = list.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(value))
  if (index >= 0) return [...list]
  return [...list, value]
}

function without<T>(list: readonly T[], predicate: (entry: T) => boolean): T[] {
  return list.filter((entry) => !predicate(entry))
}

/** Seed a graph for a tenant from its resolved config. */
export function seedContextGraph(config: ClientConfig, route = '/'): ContextGraph {
  return {
    tenantId: config.tenantId,
    page: {
      route,
      kind: 'home',
      section: undefined,
      locale: config.primaryLanguage,
    },
    entities: [],
    comparison: { entityIds: [] },
    form: undefined,
    cart: undefined,
    checkout: undefined,
    session: { authenticated: false },
    availableActions: [],
    errors: [],
    activePanel: undefined,
  }
}

/** Pure reducer: (graph, event) => graph. Never mutates its input. */
export function reduceContextGraph(graph: ContextGraph, event: ContextEvent): ContextGraph {
  switch (event.type) {
    case 'page/route':
      return { ...graph, page: { ...graph.page, route: event.route, kind: event.kind ?? graph.page.kind } }
    case 'page/section':
      return { ...graph, page: { ...graph.page, section: event.section } }
    case 'page/locale':
      return { ...graph, page: { ...graph.page, locale: event.locale } }
    case 'page/activePanel':
      return { ...graph, activePanel: event.panel ?? undefined }
    case 'entities/set':
      return { ...graph, entities: [...event.entities] }
    case 'entities/select': {
      const already = graph.entities.some((entity) => entity.id === event.entityId)
      return already ? graph : { ...graph, entities: [...graph.entities, { id: event.entityId, name: event.entityId, kind: 'unknown' }] }
    }
    case 'entities/deselect':
      return { ...graph, entities: [] }
    case 'comparison/set':
      return { ...graph, comparison: { entityIds: [...event.entityIds], metric: event.metric } }
    case 'form/set':
      return event.form ? { ...graph, form: event.form } : { ...graph, form: undefined }
    case 'form/fieldCompleted': {
      if (!graph.form) return graph
      return {
        ...graph,
        form: {
          ...graph.form,
          completedFields: replace(graph.form.completedFields, event.field),
          pendingFields: without(graph.form.pendingFields, (field) => field === event.field),
        },
      }
    }
    case 'cart/set':
      return event.cart ? { ...graph, cart: event.cart } : { ...graph, cart: undefined }
    case 'checkout/step':
      return {
        ...graph,
        checkout: { step: event.step, index: event.index, total: event.total },
      }
    case 'session/authenticated':
      return { ...graph, session: { authenticated: true, role: event.role, customerRef: event.customerRef } }
    case 'session/anonymous':
      return { ...graph, session: { authenticated: false } }
    case 'action/set':
      return { ...graph, availableActions: [...event.actions] }
    case 'action/enabled':
      return {
        ...graph,
        availableActions: graph.availableActions.map((action) =>
          action.name === event.name ? { ...action, enabled: event.enabled } : action,
        ),
      }
    case 'error/recorded':
      return { ...graph, errors: [...graph.errors, { code: event.code, occurredAt: event.occurredAt }] }
    case 'error/cleared':
      return { ...graph, errors: [] }
    default:
      return graph
  }
}

/** Apply an ordered event list to a seed graph. */
export function foldContextEvents(graph: ContextGraph, events: readonly ContextEvent[]): ContextGraph {
  return events.reduce(reduceContextGraph, graph)
}

/**
 * Actions the assistant may offer, derived from capability AND page state.
 * Page context can only *narrow* what the capability permits; it can never
 * widen it. This is the single guard that keeps the assistant from promising
 * an action the platform cannot perform.
 */
export function actionableContext(graph: ContextGraph, capabilityAllowed: readonly string[]): ContextGraph {
  return {
    ...graph,
    availableActions: graph.availableActions.filter((action) => capabilityAllowed.includes(action.name)),
  }
}

/** Validate an untrusted graph (e.g. arriving from the SDK over the wire). */
export function parseContextGraph(raw: unknown): ContextGraph {
  const parsed = contextGraphSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid context graph: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    )
  }
  return parsed.data
}
