/**
 * The shell: the only file in this package that touches a DOM.
 *
 * PRD §24 requires the embed to be *isolated* — the host page's CSS must not
 * restyle the assistant's cards, and the assistant's CSS must not restyle the
 * host page. A shadow root is the only browser mechanism that delivers both
 * directions at once, so `mount` opens one and never falls back: a host that
 * cannot attach a shadow root gets an error, not a silently unstyled chat box
 * leaking into the page it was asked to stay out of.
 *
 * Three rules the rest of the file exists to enforce:
 *
 *   1. **It draws, it never decides.** Every value it writes into the DOM came
 *      out of `toChatMessages`. The shell does not recompute a price, reorder a
 *      recommendation, or re-derive whether an action is allowed. A block is a
 *      statement the pipeline already vouchsafed.
 *   2. **Text is text.** `createElement` + `textContent` only. No `innerHTML`,
 *      ever: a reason string authored from a tenant's content reaches the screen
 *      the same way a visitor's own words do, as characters, and cannot become
 *      markup halfway through.
 *   3. **It does not run actions.** A drawn CTA emits a `ChatEvent`; the host
 *      decides what to do with it. The gate (§18) has already said what is
 *      allowed — the browser is not the place to test that a second time, and a
 *      click handler that called an API itself would put a client-side action
 *      outside the gate that approved it.
 */

import type { Branding } from '@archava/config'
import type { TurnOutcome } from '@archava/assistant'
import { describeBlock, toChatMessages } from './view.js'
import type { ChatBlock, TurnCitation } from './view.js'
import { chatSheet } from './styles.js'

/** Raised when a host is mounted twice. */
export class ChatMountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatMountError'
  }
}

/** Raised when the host page offers no DOM to build in, or no shadow root. */
export class ChatEnvironmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatEnvironmentError'
  }
}

/**
 * The attribute that marks a host as already mounted.
 *
 * Read before writing anything, so a second `mount` on the same element fails
 * loudly instead of double-rendering a chat log the visitor sees twice.
 */
const MOUNTED_ATTRIBUTE = 'data-archava-chat'
const MOUNTED_VALUE = 'mounted'

/** Messages beyond this are dropped from the log, oldest first. */
const MAX_LOG_MESSAGES = 50

/**
 * The shape of a DOM element this package uses.
 *
 * Structural rather than `lib.dom`: it lets the shell be mounted in a test with
 * a hand-built fake, and it keeps a host page that lacks a member from being a
 * compile error. Unlike the SDK's scout, every member here is required — a node
 * that cannot hold text or children is not a node, and pretending otherwise
 * would make the shell draw nothing and say nothing.
 */
export interface ChatNodeLike {
  readonly tagName: string
  readonly children: readonly ChatNodeLike[]
  textContent: string | null
  /** The composer's text. Only inputs carry one; everything else leaves it absent. */
  value?: string
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  appendChild(child: ChatNodeLike): ChatNodeLike
  removeChild(child: ChatNodeLike): ChatNodeLike
  replaceChild(next: ChatNodeLike, previous: ChatNodeLike): ChatNodeLike
  addEventListener(type: string, listener: (event: ChatEventLike) => void): void
  removeEventListener(type: string, listener: (event: ChatEventLike) => void): void
  focus?(): void
}

/** A click or a keypress, as far as the shell looks. */
export interface ChatEventLike {
  readonly type: string
  /**
   * The key that was pressed, when the event carried one. Everything else about
   * a keyboard event — modifier state, repeat count — stays with the DOM, and
   * only `key` is here because it is the only part the shell asks about: the
   * composer submits on Enter and on nothing else.
   */
  readonly key?: string
}

/** The document the host offers. Only `createElement` is needed. */
export interface ChatDocumentLike {
  createElement(tagName: string): ChatNodeLike
}

/** The shadow root the shell draws into. */
export interface ChatRootLike {
  appendChild(child: ChatNodeLike): ChatNodeLike
  removeChild(child: ChatNodeLike): ChatNodeLike
}

/** The element the host asks the chat to live inside. */
export interface ChatHostLike {
  readonly ownerDocument?: ChatDocumentLike | null
  attachShadow?(options?: { readonly mode?: 'open' | 'closed' }): ChatRootLike | null
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
}

/**
 * Something a visitor did, as the host hears about it.
 *
 * The union is the whole vocabulary. `action_requested` deliberately carries the
 * same `actionId` the gate permitted, so a host cannot accidentally run an
 * action that was never in the permitted set — there is no other field to put
 * an invented id in.
 */
export type ChatEvent =
  | { readonly kind: 'message_submitted'; readonly text: string }
  | {
      readonly kind: 'action_requested'
      readonly actionId: string
      readonly label: string
      readonly inputs: Readonly<Record<string, unknown>>
    }
  | { readonly kind: 'action_declined'; readonly actionId: string }
  | {
      readonly kind: 'slot_selected'
      readonly subjectId: string
      readonly slot: string
    }
  | { readonly kind: 'handoff_requested'; readonly label: string }

export interface ChatMountOptions {
  /** The tenant's locale, which decides how a total reads. Defaults to `en`. */
  readonly locale?: string
  /** Draw the §16 inspector panel: masking notes, refusals, the permitted set. */
  readonly inspect?: boolean
  /** Palette and typography for the sheet. No arbitrary CSS is accepted. */
  readonly branding?: Branding | null
  /** Where visitor actions go. Absent means the shell is a presentation-only embed. */
  readonly onEvent?: (event: ChatEvent) => void
  /** The DOM to build in. Defaults to the host's own document. */
  readonly document?: ChatDocumentLike | null
}

/** What `mount` hands back: one handle per host. */
export interface ChatHandle {
  readonly root: ChatRootLike
  /** Draw a decided turn. Showing the same turn twice redraws it once. */
  show(outcome: TurnOutcome): void
  /** Empty the log without unmounting. */
  clear(): void
  /** Unmount and release the host for another `mount`. */
  destroy(): void
}

interface Builder {
  readonly doc: ChatDocumentLike
  readonly emit: (event: ChatEvent) => void
}

/**
 * Open the shadow root and draw into it.
 *
 * A second call on the same host throws: `data-archava-chat="mounted"` is set on
 * the first call and checked on the second, so the failure does not depend on
 * this module's own bookkeeping surviving a page's script reload.
 */
export function mount(host: ChatHostLike, options: ChatMountOptions = {}): ChatHandle {
  if (host.getAttribute(MOUNTED_ATTRIBUTE) === MOUNTED_VALUE) {
    throw new ChatMountError(
      'This host is already mounted. Call destroy() on the first handle before mounting again.',
    )
  }
  // `??` would be the wrong operator: `{ document: null }` is a host that knows
  // it has no document, and falling through to the host's own would quietly
  // mount into one the caller had already ruled out.
  const doc = options.document === undefined ? (host.ownerDocument ?? null) : options.document
  if (doc === null || typeof doc.createElement !== 'function') {
    throw new ChatEnvironmentError('No document is available; the chat shell requires a DOM.')
  }
  const root = host.attachShadow?.({ mode: 'open' }) ?? null
  if (root === null) {
    throw new ChatEnvironmentError(
      'The host cannot attach a shadow root, so PRD §24 isolation is impossible.',
    )
  }
  host.setAttribute(MOUNTED_ATTRIBUTE, MOUNTED_VALUE)

  const theme = options.branding?.theme ?? null
  const builder: Builder = {
    doc,
    emit: (event) => {
      options.onEvent?.(event)
    },
  }
  const viewOptions = {
    locale: options.locale ?? 'en',
    inspect: options.inspect === true,
  }

  const sheet = element(builder, 'style', ['archava-sheet'])
  sheet.textContent = chatSheet(theme)
  root.appendChild(sheet)

  const log = element(builder, 'ul', ['archava-log'])
  log.setAttribute('role', 'log')
  log.setAttribute('aria-live', 'polite')
  log.setAttribute('aria-label', 'Conversation')
  root.appendChild(log)

  const composerNode = composer(builder)
  root.appendChild(composerNode)

  const drawn = new Map<string, ChatNodeLike>()

  return {
    root,
    show(outcome: TurnOutcome): void {
      const message = toChatMessages(outcome, viewOptions)
      const existing = drawn.get(message.key)
      if (existing === undefined) {
        const li = element(builder, 'li', ['archava-message'])
        li.setAttribute('data-key', message.key)
        li.setAttribute('data-time', message.occurredAt)
        renderBlocks(builder, li, message.blocks)
        drawn.set(message.key, li)
        log.appendChild(li)
        prune(log, drawn)
        return
      }
      renderBlocks(builder, existing, message.blocks)
    },
    clear(): void {
      drawn.clear()
      removeChildren(log)
    },
    destroy(): void {
      drawn.clear()
      removeChildren(log)
      root.removeChild(sheet)
      root.removeChild(log)
      root.removeChild(composerNode)
      host.setAttribute(MOUNTED_ATTRIBUTE, 'unmounted')
    },
  }
}

/* --------------------------------------------------------------- rendering -- */

/**
 * The blocks of one message, as children of one `li`.
 *
 * Append-mostly, then correct: a child that is missing is appended, a child
 * whose block no longer matches is replaced, and children left over at the end
 * are removed. A node is compared by `describeBlock`, so a block whose text
 * changed is rebuilt rather than mutated — what a visitor reads must always be
 * the value the pipeline produced, never a DOM node that drifted from it.
 */
function renderBlocks(builder: Builder, parent: ChatNodeLike, blocks: readonly ChatBlock[]): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined) {
      continue
    }
    const text = describeBlock(block)
    const current = parent.children[index] ?? null
    if (current === null) {
      parent.appendChild(blockElement(builder, block))
      continue
    }
    if (current.getAttribute('data-text') !== text) {
      parent.replaceChild(blockElement(builder, block), current)
    }
  }
  while (parent.children.length > blocks.length) {
    const last = parent.children[parent.children.length - 1]
    if (last === undefined) {
      return
    }
    parent.removeChild(last)
  }
}

/** Keep the log bounded. The oldest message leaves the DOM and the memory of it together. */
function prune(log: ChatNodeLike, drawn: Map<string, ChatNodeLike>): void {
  while (drawn.size > MAX_LOG_MESSAGES) {
    const oldest = drawn.keys().next()
    if (oldest.done === true) {
      return
    }
    const node = drawn.get(oldest.value)
    drawn.delete(oldest.value)
    if (node !== undefined) {
      log.removeChild(node)
    }
  }
}

function removeChildren(node: ChatNodeLike): void {
  while (node.children.length > 0) {
    const last = node.children[node.children.length - 1]
    if (last === undefined) {
      return
    }
    node.removeChild(last)
  }
}

function composer(builder: Builder): ChatNodeLike {
  const wrapper = element(builder, 'div', ['archava-composer'])
  const input = element(builder, 'input', ['archava-composer-input'])
  input.setAttribute('type', 'text')
  input.setAttribute('aria-label', 'Message')
  input.setAttribute('placeholder', 'Ask a question')
  input.value = ''

  // One submit path, taken by the button and by Enter alike. A text field that
  // only responds to its button teaches a visitor that typing is not the thing
  // this field is for, and the whole reference page is meant to be used the way
  // a visitor would use it. `type === "keydown"` with `key === "Enter"` is that
  // path: submit-once-per-keypress, so holding the key cannot fire a turn per
  // repeat, and a field with nothing in it submits nothing at all.
  function submit(): void {
    const text = (input.value ?? '').trim()
    if (text.length === 0) {
      return
    }
    input.value = ''
    builder.emit({ kind: 'message_submitted', text })
  }

  const send = element(builder, 'button', ['archava-composer-send'])
  send.setAttribute('type', 'button')
  send.textContent = 'Send'
  send.addEventListener('click', () => submit())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      submit()
    }
  })
  wrapper.appendChild(input)
  wrapper.appendChild(send)
  return wrapper
}

function blockElement(builder: Builder, block: ChatBlock): ChatNodeLike {
  // The kind is carried in `data-text`, never in the class list. A wrapper that
  // repeated its block's class would shadow the element a host looks for: a
  // search for `archava-cta` or `archava-text` would stop at this div instead of
  // reaching the button or paragraph that owns it.
  const node = element(builder, 'div', ['archava-block'])
  const text = describeBlock(block)
  node.setAttribute('data-text', text)
  // A tooltip costs nothing and makes a shell debuggable in a real browser:
  // hovering a card shows exactly what the block claimed.
  node.setAttribute('title', text)
  appendBody(builder, node, block)
  return node
}

function appendBody(builder: Builder, node: ChatNodeLike, block: ChatBlock): void {
  switch (block.kind) {
    case 'text':
      appendText(node, builder, block.text)
      return
    case 'banner':
      appendBanner(builder, node, block.message, block.tone)
      return
    case 'basis':
      appendBasis(builder, node, block.basis)
      return
    case 'truth':
      appendTruth(builder, node, block)
      return
    case 'sources':
      appendTitles(builder, node, 'archava-sources', block.citations.map(citationTitle))
      return
    case 'recommendations':
      appendRecommendations(builder, node, block.items)
      return
    case 'matrix':
      appendMatrix(builder, node, block.entityIds, block.metrics)
      return
    case 'shortlist':
      appendTitles(builder, node, 'archava-shortlist', block.entityIds)
      return
    case 'picker':
      appendPicker(builder, node, block.subjectId, block.subjectName, block.slots)
      return
    case 'order':
      appendOrder(builder, node, block.orderId, block.amount, block.stage)
      return
    case 'sourceCard':
      appendSourceCard(builder, node, block.sourceTitle, block.excerpt)
      return
    case 'cta':
      appendCta(builder, node, block.actionId, block.label)
      return
    case 'confirmation':
      appendConfirmation(builder, node, block)
      return
    case 'declined':
      appendDeclined(builder, node, block)
      return
    case 'result':
      appendResult(builder, node, block.actionId, block.reason)
      return
    case 'handoff':
      appendHandoff(builder, node, block.summary)
      return
    case 'inspector':
      appendInspector(builder, node, block)
      return
    default:
      return skip(block)
  }
}

function appendText(node: ChatNodeLike, builder: Builder, text: string): void {
  const paragraph = element(builder, 'p', ['archava-text'])
  paragraph.textContent = text
  node.appendChild(paragraph)
}

function appendBanner(builder: Builder, node: ChatNodeLike, message: string, tone: string): void {
  const banner = element(builder, 'p', ['archava-banner', `archava-banner-${tone}`])
  banner.setAttribute('role', 'status')
  banner.textContent = message
  node.appendChild(banner)
}

const BASIS_LABEL: Readonly<Record<string, string>> = {
  structured_truth: 'Live data',
  retrieval: 'From the knowledge base',
  none: 'No source',
}

function appendBasis(builder: Builder, node: ChatNodeLike, basis: string): void {
  const badge = element(builder, 'span', ['archava-basis'])
  badge.setAttribute('data-basis', basis)
  badge.textContent = BASIS_LABEL[basis] ?? basis
  node.appendChild(badge)
}

function appendTruth(
  builder: Builder,
  node: ChatNodeLike,
  block: Extract<ChatBlock, { kind: 'truth' }>,
): void {
  const table = element(builder, 'table', ['archava-truth'])
  const body = element(builder, 'tbody')
  for (const row of block.rows) {
    const tr = element(builder, 'tr', ['archava-truth-row'])
    const subject = element(builder, 'th', ['archava-truth-subject'])
    subject.textContent = row.subject
    const path = element(builder, 'td', ['archava-truth-path'])
    path.textContent = row.path
    const value = element(builder, 'td', ['archava-truth-value'])
    value.textContent = row.value
    tr.appendChild(subject)
    tr.appendChild(path)
    tr.appendChild(value)
    body.appendChild(tr)
  }
  table.appendChild(body)
  node.appendChild(table)
  if (block.truncated) {
    const note = element(builder, 'p', ['archava-truth-truncated'])
    note.textContent = 'Deeper values were not shown.'
    node.appendChild(note)
  }
}

function appendTitles(
  builder: Builder,
  node: ChatNodeLike,
  className: string,
  titles: readonly string[],
): void {
  // The class belongs to the item, not to the list that carries it. A host that
  // asks for `.archava-sources` wants the title — and `textContent` on the
  // wrapper is its children's, not its own.
  const list = element(builder, 'ul', ['archava-titles'])
  for (const title of titles) {
    const li = element(builder, 'li', [className])
    li.textContent = title
    list.appendChild(li)
  }
  node.appendChild(list)
}

function citationTitle(citation: TurnCitation): string {
  return citation.sourceTitle
}

function appendRecommendations(
  builder: Builder,
  node: ChatNodeLike,
  items: readonly {
    readonly entityId: string
    readonly entityName: string
    readonly reason: string
  }[],
): void {
  const list = element(builder, 'ul', ['archava-recommendations'])
  for (const item of items) {
    const li = element(builder, 'li', ['archava-recommendation'])
    li.setAttribute('data-entity', item.entityId)
    const name = element(builder, 'span', ['archava-recommendation-name'])
    name.textContent = item.entityName
    const reason = element(builder, 'p', ['archava-recommendation-reason'])
    reason.textContent = item.reason
    li.appendChild(name)
    li.appendChild(reason)
    list.appendChild(li)
  }
  node.appendChild(list)
}

/**
 * A frame, never an answer.
 *
 * Every cell is empty on purpose. The tenant fills them from their own systems;
 * a cell the assistant filled in would be §17's failure in miniature, and a
 * cell left blank says so honestly.
 */
function appendMatrix(
  builder: Builder,
  node: ChatNodeLike,
  entityIds: readonly string[],
  metrics: readonly string[],
): void {
  const table = element(builder, 'table', ['archava-matrix'])
  // No `thead`/`tbody` wrappers: the rows are the table's own children, so a host
  // filling the frame walks one level (`rows` → `cells`) rather than reaching
  // through a grouping box that only exists to satisfy a validator.
  const headRow = element(builder, 'tr')
  const corner = element(builder, 'th')
  corner.textContent = 'Compare'
  headRow.appendChild(corner)
  for (const metric of metrics) {
    const th = element(builder, 'th')
    th.textContent = metric
    headRow.appendChild(th)
  }
  table.appendChild(headRow)
  for (const entityId of entityIds) {
    const tr = element(builder, 'tr')
    const th = element(builder, 'th')
    th.textContent = entityId
    tr.appendChild(th)
    for (const metric of metrics) {
      const td = element(builder, 'td')
      // Empty on purpose, and said so rather than left undefined: the tenant
      // fills the frame from their own systems, and a cell that is blank
      // because nobody wrote to it reads differently from one that is blank
      // because there is nothing to put in it.
      td.textContent = ''
      td.setAttribute('data-entity', entityId)
      td.setAttribute('data-metric', metric)
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }
  node.appendChild(table)
  const note = element(builder, 'p', ['archava-matrix-note'])
  note.textContent = 'Values come from the tenant’s own systems.'
  node.appendChild(note)
}

function appendPicker(
  builder: Builder,
  node: ChatNodeLike,
  subjectId: string,
  subjectName: string,
  slots: readonly string[],
): void {
  const wrapper = element(builder, 'div', ['archava-picker'])
  const heading = element(builder, 'p', ['archava-picker-subject'])
  heading.textContent = subjectName
  wrapper.appendChild(heading)
  const list = element(builder, 'ul', ['archava-picker-slots'])
  for (const slot of slots) {
    const li = element(builder, 'li')
    const button = element(builder, 'button', ['archava-slot'])
    button.setAttribute('type', 'button')
    button.setAttribute('data-slot', slot)
    // Carried verbatim: the shell never reparses a timestamp into a friendlier
    // one, because a reparsed slot is a slot the authoritative system did not
    // offer.
    button.textContent = slot
    button.addEventListener('click', () => {
      builder.emit({ kind: 'slot_selected', subjectId, slot })
    })
    li.appendChild(button)
    list.appendChild(li)
  }
  wrapper.appendChild(list)
  node.appendChild(wrapper)
}

function appendOrder(
  builder: Builder,
  node: ChatNodeLike,
  orderId: string,
  amount: string,
  stage: string,
): void {
  const card = element(builder, 'div', ['archava-order'])
  const id = element(builder, 'span', ['archava-order-id'])
  id.textContent = orderId
  const total = element(builder, 'span', ['archava-order-amount'])
  total.textContent = amount
  const state = element(builder, 'span', ['archava-order-stage'])
  state.textContent = stage
  card.appendChild(id)
  card.appendChild(total)
  card.appendChild(state)
  node.appendChild(card)
}

function appendSourceCard(
  builder: Builder,
  node: ChatNodeLike,
  title: string,
  excerpt: string,
): void {
  const card = element(builder, 'figure', ['archava-source-card'])
  const caption = element(builder, 'figcaption', ['archava-source-title'])
  caption.textContent = title
  const quote = element(builder, 'blockquote')
  quote.textContent = excerpt
  card.appendChild(caption)
  card.appendChild(quote)
  node.appendChild(card)
}

function appendCta(builder: Builder, node: ChatNodeLike, actionId: string, label: string): void {
  const button = element(builder, 'button', ['archava-cta'])
  button.setAttribute('type', 'button')
  button.setAttribute('data-action-id', actionId)
  button.textContent = label
  button.addEventListener('click', () => {
    builder.emit({ kind: 'action_requested', actionId, label, inputs: {} })
  })
  node.appendChild(button)
}

/**
 * A held action: the yes/no card, never a claim that it happened.
 *
 * The confirm button re-emits the gated `inputs` unchanged. Rebuilding them here
 * would let the shell change what the visitor is agreeing to.
 */
function appendConfirmation(
  builder: Builder,
  node: ChatNodeLike,
  block: Extract<ChatBlock, { kind: 'confirmation' }>,
): void {
  const card = element(builder, 'div', ['archava-confirmation'])
  card.setAttribute('role', 'group')
  card.setAttribute('data-action-id', block.actionId)
  const prompt = element(builder, 'p', ['archava-confirmation-prompt'])
  prompt.textContent = block.prompt ?? `Confirm ${block.actionId}?`
  card.appendChild(prompt)
  if (block.reason !== undefined) {
    const reason = element(builder, 'p', ['archava-confirmation-reason'])
    reason.textContent = block.reason
    card.appendChild(reason)
  }
  const confirm = element(builder, 'button', ['archava-confirmation-confirm'])
  confirm.setAttribute('type', 'button')
  confirm.textContent = 'Confirm'
  confirm.addEventListener('click', () => {
    builder.emit({
      kind: 'action_requested',
      actionId: block.actionId,
      label: block.prompt ?? block.actionId,
      inputs: block.inputs,
    })
  })
  const decline = element(builder, 'button', ['archava-confirmation-decline'])
  decline.setAttribute('type', 'button')
  decline.textContent = 'Not now'
  decline.addEventListener('click', () => {
    builder.emit({ kind: 'action_declined', actionId: block.actionId })
  })
  card.appendChild(confirm)
  card.appendChild(decline)
  node.appendChild(card)
}

/**
 * An action the visitor refused, and the one button that un-refuses it.
 *
 * The question was already answered, so this is not a confirmation card and does
 * not offer "Not now" a second time — a decline button on a declined action would
 * be asking the visitor to answer a question they already answered, which is the
 * re-ask in a thinner disguise. What it carries is the way back: a confirm that
 * names the same action with the same inputs, so lifting the refusal is a click
 * rather than retyping the request the gate is holding against them.
 *
 * It reuses the confirmation card's classes deliberately. A page that observes the
 * shell (or an operator reading a screenshot) sees one shape for "an action is
 * waiting on this visitor", and the class a test or a stylesheet already knows
 * still finds it. What differs is inside: the reason, the absent decline button,
 * and text that says the refusal happened rather than pretending it did not.
 */
function appendDeclined(
  builder: Builder,
  node: ChatNodeLike,
  block: Extract<ChatBlock, { kind: 'declined' }>,
): void {
  const card = element(builder, 'div', ['archava-confirmation'])
  card.setAttribute('role', 'group')
  card.setAttribute('data-action-id', block.actionId)
  card.setAttribute('data-archava-declined', 'true')
  const prompt = element(builder, 'p', ['archava-confirmation-prompt'])
  prompt.textContent = block.prompt ?? `Declined: ${block.actionId}`
  card.appendChild(prompt)
  const reason = element(builder, 'p', ['archava-confirmation-reason'])
  reason.textContent = block.reason ?? 'You said no to this earlier in this session.'
  card.appendChild(reason)
  const confirm = element(builder, 'button', ['archava-confirmation-confirm'])
  confirm.setAttribute('type', 'button')
  confirm.textContent = 'After all, do it'
  confirm.addEventListener('click', () => {
    builder.emit({
      kind: 'action_requested',
      actionId: block.actionId,
      label: block.prompt ?? block.actionId,
      inputs: block.inputs,
    })
  })
  card.appendChild(confirm)
  node.appendChild(card)
}

function appendResult(
  builder: Builder,
  node: ChatNodeLike,
  actionId: string,
  reason: string | undefined,
): void {
  const done = element(builder, 'p', ['archava-result'])
  done.setAttribute('data-action-id', actionId)
  done.textContent = reason ?? 'Done'
  node.appendChild(done)
}

function appendHandoff(builder: Builder, node: ChatNodeLike, summary: string): void {
  const card = element(builder, 'div', ['archava-handoff'])
  const text = element(builder, 'p', ['archava-handoff-summary'])
  text.textContent = summary
  card.appendChild(text)
  const button = element(builder, 'button', ['archava-handoff-cta'])
  button.setAttribute('type', 'button')
  button.textContent = 'Talk to a person'
  button.addEventListener('click', () => {
    builder.emit({ kind: 'handoff_requested', label: 'Talk to a person' })
  })
  card.appendChild(button)
  node.appendChild(card)
}

function appendInspector(
  builder: Builder,
  node: ChatNodeLike,
  block: Extract<ChatBlock, { kind: 'inspector' }>,
): void {
  const details = element(builder, 'details', ['archava-inspector'])
  const summary = element(builder, 'summary')
  summary.textContent = 'What this turn withheld'
  details.appendChild(summary)
  appendItems(builder, details, 'archava-notice', block.notices)
  appendItems(builder, details, 'archava-rejected', block.rejectedComponents)
  appendItems(builder, details, 'archava-withheld', block.withheldCtas)
  const permitted = element(builder, 'p', ['archava-permitted'])
  permitted.textContent =
    block.permittedActionIds.length > 0
      ? `Permitted: ${block.permittedActionIds.join(', ')}`
      : 'Permitted: none'
  details.appendChild(permitted)
  node.appendChild(details)
}

function appendItems(
  builder: Builder,
  parent: ChatNodeLike,
  className: string,
  texts: readonly string[],
): void {
  for (const text of texts) {
    const li = element(builder, 'li', [className])
    li.textContent = text
    parent.appendChild(li)
  }
}

/* ------------------------------------------------------------------ utils -- */

/**
 * An element, named the way the DOM answers.
 *
 * `createElement` in an HTML document hands back an upper-case `tagName` — `td`
 * comes back as `TD` — so the shell asks in that case rather than relying on the
 * host to normalise. A host that records the name verbatim then sees what a real
 * document would have said, and a host filling a comparison frame can match
 * `row.cells` without a case-insensitive comparison.
 */
function element(builder: Builder, tagName: string, classes: readonly string[] = []): ChatNodeLike {
  const node = builder.doc.createElement(tagName.toUpperCase())
  if (classes.length > 0) {
    node.setAttribute('class', classes.join(' '))
  }
  return node
}

/**
 * A block kind this file has no drawer for.
 *
 * It stays invisible rather than becoming an apology at a visitor: §25 already
 * validated the component, so the pipeline's considered opinion is that it
 * belongs. A shell that printed `[unrendered component]` would be hiding a
 * catalog problem behind a message the visitor cannot act on.
 */
function skip(block: never): void {
  void block
}
