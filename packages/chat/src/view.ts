/**
 * The view model: one decided turn, as the blocks a shell can draw.
 *
 * This is the seam between the assistant and the DOM. Everything above it (the
 * turn pipeline, PRD §16 context, §17 knowledge, §18 policy) has already
 * decided what is true and what may be shown; everything below it (`dom.ts`)
 * only knows how to make elements. Keeping a typed block list between them
 * buys three things:
 *
 *   1. **The shell cannot re-decide.** A block carries a value; it never asks
 *      where the value came from. A shell that wanted to "helpfully" recompute
 *      a price would have to ignore the `order` block and invent one.
 *   2. **Rendering is testable without a DOM.** `toChatMessages` is pure, so a
 *      test can assert that an action the gate held back produced a
 *      confirmation block, not a result block.
 *   3. **A refused component is visible.** §25 rejects invalid components
 *      rather than fixing them; the inspector block lists what was refused and
 *      why, so a tenant fixing a catalog can see the rejection instead of
 *      guessing why the turn looked thinner than the request.
 *
 * Every block is derived from the outcome's own data. Where a block needs a
 * number a visitor reads, that number comes from `formatMoney`, which takes
 * the divisor from the currency rather than assuming two decimal places — an
 * IDR night rate is whole rupiah, and off-by-100 on a quote under-charges a
 * guest.
 */

import { filterComponentsByAllowedActions } from '@archava/assistant'
import type {
  AnswerBasis,
  GenerativeComponent,
  GenerativeComponentKind,
  TurnOutcome,
} from '@archava/assistant'
import { formatMoney } from './money.js'

/** How deep a nested structured-truth value is flattened into `path = value` rows. */
const MAX_TRUTH_DEPTH = 3

/** A single citation, named after the outcome's own shape so the two cannot drift. */
export type TurnCitation = TurnOutcome['citations'][number]

/** The props of one §25 component kind, so a block never restates its schema. */
type PropsOf<Kind extends GenerativeComponentKind> = Extract<
  GenerativeComponent,
  { readonly kind: Kind }
>['props']

/** Why the shell should draw something a visitor did not ask for. */
export type BannerTone = 'gap' | 'info'

/**
 * A row of the structured-truth panel.
 *
 * `subject` is the truth subject the value was resolved for; `path` is the
 * dotted path inside it; `value` is the producer's own rendering. The view
 * does arithmetic on none of them.
 */
export interface TruthRow {
  readonly subject: string
  readonly path: string
  readonly value: string
}

export interface TextBlock {
  readonly kind: 'text'
  readonly text: string
}

export interface BannerBlock {
  readonly kind: 'banner'
  readonly tone: BannerTone
  readonly message: string
}

/** Trust badge: what the answer was grounded in (§17's structured-truth split). */
export interface BasisBlock {
  readonly kind: 'basis'
  readonly basis: AnswerBasis
}

/** The structured-truth panel — the thing a price is never rewritten into prose. */
export interface TruthBlock {
  readonly kind: 'truth'
  readonly rows: readonly TruthRow[]
  /** True when the record went deeper than {@link MAX_TRUTH_DEPTH} and was cut. */
  readonly truncated: boolean
}

export interface SourcesBlock {
  readonly kind: 'sources'
  readonly citations: readonly TurnCitation[]
}

export interface RecommendationBlock {
  readonly kind: 'recommendations'
  readonly items: PropsOf<'recommendation_list'>['items']
}

/**
 * A comparison frame, never a filled answer.
 *
 * The tenant says which entities and which metrics to compare. The cells are
 * the host's to fill from its own systems, because a matrix whose numbers the
 * assistant invented is exactly the failure §17 exists to prevent.
 */
export interface MatrixBlock {
  readonly kind: 'matrix'
  readonly entityIds: PropsOf<'comparison_table'>['entityIds']
  readonly metrics: PropsOf<'comparison_table'>['metrics']
}

export interface ShortlistBlock {
  readonly kind: 'shortlist'
  readonly entityIds: PropsOf<'product_shortlist'>['entityIds']
}

/** Availability slots, carried verbatim — the shell never reparses a timestamp. */
export interface PickerBlock {
  readonly kind: 'picker'
  readonly subjectId: PropsOf<'booking_picker'>['subjectId']
  readonly subjectName: PropsOf<'booking_picker'>['subjectName']
  readonly slots: PropsOf<'booking_picker'>['slots']
}

/** A total, formatted by the currency's own minor unit. */
export interface OrderBlock {
  readonly kind: 'order'
  readonly orderId: PropsOf<'order_summary'>['orderId']
  readonly amount: string
  readonly currency: PropsOf<'order_summary'>['currency']
  readonly stage: PropsOf<'order_summary'>['stage']
}

export interface SourceCardBlock {
  readonly kind: 'sourceCard'
  readonly sourceId: PropsOf<'faq_source_card'>['sourceId']
  readonly sourceTitle: PropsOf<'faq_source_card'>['sourceTitle']
  readonly excerpt: PropsOf<'faq_source_card'>['excerpt']
}

/** A call to action the visitor may still take: §18 already permitted it. */
export interface CtaBlock {
  readonly kind: 'cta'
  readonly label: PropsOf<'cta'>['label']
  readonly actionId: PropsOf<'cta'>['actionId']
}

/** An action the gate held back pending a human yes (§18's confirmation step). */
export interface ConfirmationBlock {
  readonly kind: 'confirmation'
  readonly actionId: string
  readonly reason: string | undefined
  readonly prompt: string | undefined
  readonly inputs: Readonly<Record<string, unknown>>
}

/**
 * An action the visitor earlier refused, and the way back to it.
 *
 * A decline is a refusal, not a ban: `declined_by_visitor` stops the gate from
 * re-asking, and a confirmation in the same turn lifts it. But the shell used
 * to draw nothing at all for a denied action, so the only thing the visitor
 * could do after saying "not now" was un-decline it by typing the whole request
 * again — which is the same re-ask, disguised as a conversation. Drawing the
 * refusal is what keeps it a decision the visitor made rather than a wall.
 *
 * It is not a `confirmation` block: the question was already answered, and the
 * card has to say so rather than pretend to be a first-time ask.
 */
export interface DeclinedBlock {
  readonly kind: 'declined'
  readonly actionId: string
  readonly reason: string | undefined
  readonly prompt: string | undefined
  readonly inputs: Readonly<Record<string, unknown>>
}

/** An action the gate allowed *and* an executor reported successful (§18, §8). */
export interface ResultBlock {
  readonly kind: 'result'
  readonly actionId: string
  readonly reason: string | undefined
}

/** §26: the handoff reason and the summary the pipeline already wrote. */
export interface HandoffBlock {
  readonly kind: 'handoff'
  readonly reason: NonNullable<TurnOutcome['handoff']>['reason']
  readonly summary: NonNullable<TurnOutcome['handoff']>['summary']
}

/** Everything the turn withheld, so a tenant can see the withholding. */
export interface InspectorBlock {
  readonly kind: 'inspector'
  readonly notices: readonly string[]
  readonly rejectedComponents: readonly string[]
  readonly withheldCtas: readonly string[]
  readonly permittedActionIds: readonly string[]
}

/**
 * One renderable thing.
 *
 * The union is closed on purpose: adding a tenth component kind to §25 forces
 * a change here, and `blockFor`'s `default` branch narrows to `never` so an
 * unhandled kind is a compile error rather than a silently missing card.
 */
export type ChatBlock =
  | TextBlock
  | BannerBlock
  | BasisBlock
  | TruthBlock
  | SourcesBlock
  | RecommendationBlock
  | MatrixBlock
  | ShortlistBlock
  | PickerBlock
  | OrderBlock
  | SourceCardBlock
  | CtaBlock
  | ConfirmationBlock
  | DeclinedBlock
  | ResultBlock
  | HandoffBlock
  | InspectorBlock

/** One turn, keyed so a shell can redraw it without duplicating it. */
export interface ChatMessage {
  readonly key: string
  readonly occurredAt: string
  readonly blocks: readonly ChatBlock[]
}

export interface ChatViewOptions {
  /** The tenant's locale, never the browser's — it decides how a total reads. */
  readonly locale: string
  /** Include §16 masking notes, denials, refusals and the permitted set. */
  readonly inspect?: boolean
}

/** Shown when the turn admitted it had nothing to answer from. */
const GAP_MESSAGE = 'No information was found for this request in the tenant’s sources.'

/**
 * A turn as blocks, in drawing order.
 *
 * Order is not cosmetic: the trust badge comes before the answer it justifies,
 * and the structured-truth panel comes before the prose, so a visitor sees the
 * number before the sentence that talks about it. A handoff card comes last
 * because it ends the turn rather than competing with the answer.
 */
export function toChatMessages(outcome: TurnOutcome, options: ChatViewOptions): ChatMessage {
  const blocks = [
    ...basisBlocks(outcome),
    ...bannerBlocks(outcome),
    ...textBlocks(outcome),
    ...citationBlocks(outcome),
    ...truthBlocks(outcome),
    ...componentBlocks(outcome, options.locale),
    ...actionBlocks(outcome),
    ...handoffBlocks(outcome),
    ...inspectorBlocks(outcome, options),
  ]
  return {
    key: `${outcome.sessionId}:${outcome.occurredAt}`,
    occurredAt: outcome.occurredAt,
    blocks,
  }
}

/** A plain-text rendering of a block, for logs, tests, and the DOM's title tooltips. */
export function describeBlock(block: ChatBlock): string {
  switch (block.kind) {
    case 'text':
      return block.text
    case 'banner':
      return block.message
    case 'basis':
      return block.basis
    case 'truth':
      return block.rows.map((row) => `${row.path} = ${row.value}`).join('\n')
    case 'sources':
      return block.citations.map((citation) => citation.sourceTitle).join(', ')
    case 'recommendations':
      return block.items.map((item) => item.entityName).join(', ')
    case 'matrix':
      return `${block.metrics.join(', ')} for ${block.entityIds.join(', ')}`
    case 'shortlist':
      return block.entityIds.join(', ')
    case 'picker':
      return block.slots.join(', ')
    case 'order':
      return `${block.orderId} ${block.amount}`
    case 'sourceCard':
      return `${block.sourceTitle}: ${block.excerpt}`
    case 'cta':
      return block.label
    case 'confirmation':
      return block.prompt ?? `Confirm ${block.actionId}`
    case 'declined':
      return `${block.actionId} was declined: ${block.reason ?? 'declined_by_visitor'}`
    case 'result':
      return block.actionId
    case 'handoff':
      return block.summary
    case 'inspector':
      return [...block.notices, ...block.rejectedComponents, ...block.withheldCtas].join('\n')
    default:
      return `unknown block ${JSON.stringify(block satisfies never)}`
  }
}

function basisBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  return [{ kind: 'basis', basis: outcome.basis }]
}

function bannerBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  if (outcome.knowledgeGap) {
    return [{ kind: 'banner', tone: 'gap', message: GAP_MESSAGE }]
  }
  return []
}

function citationBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  // A citation is drawn by title alone, never as a link: it carries no URL, so an
  // <a href> here would be the shell inventing a destination (§17).
  if (outcome.citations.length === 0) {
    return []
  }
  return [{ kind: 'sources', citations: outcome.citations }]
}

function textBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  return outcome.text.length > 0 ? [{ kind: 'text', text: outcome.text }] : []
}

/**
 * The structured-truth record, flattened to one row per leaf.
 *
 * Values are stringified as the producer produced them: a null stays `null`, a
 * nested object keeps its shape as a path. Nothing is reformatted, because a
 * reformatted value is a value the producer did not commit to.
 */
function truthBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  if (outcome.basis !== 'structured_truth') {
    return []
  }
  const rows: TruthRow[] = []
  let truncated = false
  for (const subject of Object.keys(outcome.structuredTruth)) {
    truncated = flatten(subject, outcome.structuredTruth[subject], [], rows, 1) || truncated
  }
  return rows.length > 0 ? [{ kind: 'truth', rows, truncated }] : []
}

function flatten(
  subject: string,
  value: unknown,
  prefix: readonly string[],
  rows: TruthRow[],
  depth: number,
): boolean {
  if (depth > MAX_TRUTH_DEPTH) {
    rows.push({
      subject,
      path: `$${prefix.length > 0 ? `.${prefix.join('.')}` : ''}`,
      value: '…',
    })
    return true
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      rows.push({ subject, path: pathOf(prefix), value: '{}' })
      return false
    }
    let truncated = false
    for (const [key, child] of entries) {
      truncated = flatten(subject, child, [...prefix, key], rows, depth + 1) || truncated
    }
    return truncated
  }
  rows.push({ subject, path: pathOf(prefix), value: renderTruthValue(value) })
  return false
}

function pathOf(prefix: readonly string[]): string {
  return `$${prefix.length > 0 ? `.${prefix.join('.')}` : ''}`
}

function renderTruthValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  return JSON.stringify(value) ?? 'undefined'
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One block per §25 component, in the order the pipeline produced them.
 *
 * CTAs are re-filtered against the permitted set even though the pipeline
 * already did it: the filter is cheap, and a CTA drawn without a permission
 * behind it is the one mistake in this package with a consequence outside the
 * browser.
 */
function componentBlocks(outcome: TurnOutcome, locale: string): readonly ChatBlock[] {
  const drawn = new Set(
    filterComponentsByAllowedActions(outcome.components, outcome.permittedActionIds),
  )
  const blocks: ChatBlock[] = []
  for (const component of outcome.components) {
    if (component.kind === 'cta' && !drawn.has(component)) {
      continue
    }
    const block = blockFor(component, locale)
    if (block !== null) {
      blocks.push(block)
    }
  }
  return blocks
}

function blockFor(component: GenerativeComponent, locale: string): ChatBlock | null {
  switch (component.kind) {
    case 'recommendation_list':
      return { kind: 'recommendations', items: component.props.items }
    case 'comparison_table':
      return {
        kind: 'matrix',
        entityIds: component.props.entityIds,
        metrics: component.props.metrics,
      }
    case 'booking_picker':
      return {
        kind: 'picker',
        subjectId: component.props.subjectId,
        subjectName: component.props.subjectName,
        slots: component.props.slots,
      }
    case 'product_shortlist':
      return { kind: 'shortlist', entityIds: component.props.entityIds }
    case 'order_summary': {
      // The one place a number a visitor pays reaches the screen. The divisor
      // comes from the currency, so an IDR total stays whole rupiah.
      const amount = formatMoney(component.props.amountMinor, component.props.currency, locale)
      return {
        kind: 'order',
        orderId: component.props.orderId,
        amount,
        currency: component.props.currency,
        stage: component.props.stage,
      }
    }
    case 'faq_source_card':
      return {
        kind: 'sourceCard',
        sourceId: component.props.sourceId,
        sourceTitle: component.props.sourceTitle,
        excerpt: component.props.excerpt,
      }
    case 'cta':
      return {
        kind: 'cta',
        label: component.props.label,
        actionId: component.props.actionId,
      }
    case 'human_handoff_card':
      return null
    default:
      return describeUnknownKind(component)
  }
}

/**
 * A component kind the view has no block for.
 *
 * It becomes a `text` block naming the kind, because §25 validated it and
 * dropping it here would make the tenant's catalog look like it worked.
 */
function describeUnknownKind(component: GenerativeComponent): ChatBlock {
  return { kind: 'text', text: `[unrendered component: ${component.kind}]` }
}

/**
 * One block per gated action.
 *
 * A held action is a *confirmation*, not a result — the two render differently
 * on purpose, and conflating them would tell a visitor that a thing happened
 * the gate never allowed. The split is §18's: `policy` is the decision, and only
 * an executor reporting `succeeded` counts as a result. Anything else (denied,
 * held, or allowed but never attempted) is not shown as an outcome at all.
 */
function actionBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const action of outcome.actions) {
    if (action.policy === 'allowed' && action.execution === 'succeeded') {
      blocks.push({
        kind: 'result',
        actionId: action.actionId,
        reason: action.reason,
      })
      continue
    }
    if (action.policy === 'confirmation_required') {
      blocks.push({
        kind: 'confirmation',
        actionId: action.actionId,
        reason: action.reason,
        prompt: action.prompt,
        inputs: action.inputs,
      })
    }
    // Only the visitor's own refusal is drawn. Every other denial — a page the
    // action was never on, a role that may not run it, an admin action waiting on
    // a human — is a fact about the tenant's configuration, not a question the
    // visitor answered, and offers them nothing to click.
    if (action.policy === 'denied' && action.denialReason === 'declined_by_visitor') {
      blocks.push({
        kind: 'declined',
        actionId: action.actionId,
        reason: action.reason,
        prompt: action.prompt,
        inputs: action.inputs,
      })
    }
  }
  return blocks
}

function handoffBlocks(outcome: TurnOutcome): readonly ChatBlock[] {
  if (outcome.handoff === null) {
    return []
  }
  return [
    {
      kind: 'handoff',
      reason: outcome.handoff.reason,
      summary: outcome.handoff.summary,
    },
  ]
}

function inspectorBlocks(outcome: TurnOutcome, options: ChatViewOptions): ChatBlock[] {
  if (options.inspect !== true) {
    return []
  }
  const drawn = new Set(outcome.permittedActionIds)
  const withheldCtas = outcome.components
    .filter((component) => component.kind === 'cta' && !drawn.has(component.props.actionId))
    .map((component) => (component.kind === 'cta' ? component.props.actionId : ''))
    .filter((actionId) => actionId.length > 0)
  // An empty inspector is not a view of the withholding — it is an empty card.
  // Nothing withheld means nothing to show, so the panel stays out of the way.
  if (
    outcome.notices.length === 0 &&
    outcome.rejectedComponents.length === 0 &&
    withheldCtas.length === 0 &&
    outcome.permittedActionIds.length === 0
  ) {
    return []
  }
  return [
    {
      kind: 'inspector',
      notices: outcome.notices,
      rejectedComponents: outcome.rejectedComponents,
      withheldCtas,
      permittedActionIds: outcome.permittedActionIds,
    },
  ]
}
