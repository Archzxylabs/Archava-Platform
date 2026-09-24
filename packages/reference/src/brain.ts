/**
 * The reference brain: a scripted answer, plus the action it asked for.
 *
 * The reference tenant has to *prove* the turn pipeline, and the part that is
 * hard to prove is the action path. A brain that only ever answers a question
 * exercises consent, grounding, and retrieval and nothing else — the whole of
 * §18 (gate, confirmation, capability, denial) sits behind an action request
 * that never arrives, so it is never seen. This decorator is what makes it
 * arrive.
 *
 * It wraps any {@link BrainProvider} and adds two things: a read of what the
 * visitor asked for, in the utterance, and a request carrying the page action
 * that would satisfy it; and a rendering of a structured-truth turn into words
 * this tenant can support. Everything else — retrieval, the decline, the citation
 * list — is delegated unchanged, because the inner brain already answers those and
 * a second implementation of them here would be a second place to disagree.
 *
 * The one thing it deliberately does not do is ask whether the action is
 * permitted. `request.permittedActionIds` is the gate's answer, and a brain that
 * consults it before asking is a brain that has decided on the gate's behalf:
 * the "action above the configured capability is denied" evidence would then be
 * a brain that never asked, which is not evidence of a denial. So the request
 * goes out on its merits and the gate decides — which is exactly the sequencing
 * §16 names, where requested actions are requests and never permissions.
 *
 * It does decide what was asked for, and that part is not free of judgement:
 * "cancel my booking" and "book me a room" are the same reservation read two
 * ways, and the phrases overlap enough that a plain substring match reads both
 * as the second. So cancellation is matched ahead of everything else, and the
 * id it asks for is one the ACL does not register.
 */
import type { BrainProvider, BrainReply, BrainTurn } from '@archava/adapters'
import { renderStructuredTruth } from './prose.js'

/** What the reference brain can ask for on the page it is looking at. */
export interface ReferenceActionRequest {
  readonly actionId: string
  readonly inputs: Readonly<Record<string, unknown>>
}

/** The order the patterns are tried in, and why they are tried in it. */
const ACTION_PATTERNS: readonly {
  readonly actionId: string
  readonly phrases: readonly string[]
}[] = [
  // The two the page can run come first: they are the only actions a browser
  // can carry out, and "compare" is the clearest request a visitor makes of a
  // page of offerings.
  {
    actionId: 'ui.compare',
    phrases: ['compare', 'comparison', 'side by side', 'difference between', 'versus', ' vs '],
  },
  {
    actionId: 'ui.highlight',
    phrases: ['show me', 'highlight', 'point out', 'scroll to', 'take me to', 'focus on'],
  },
  // These two are the gate's business: `booking.create` is confirmable at the
  // reference tenant's tier, `payment.initiate` is above it. Both are requested
  // regardless, because a gate nobody asks is not a gate.
  {
    actionId: 'booking.create',
    phrases: ['book', 'reserve', 'reservation', 'hold a room'],
  },
  {
    actionId: 'payment.initiate',
    phrases: ['pay', 'payment', 'deposit', 'check out'],
  },
]

/** How many entities a comparison compares before it stops comparing. */
const MAX_COMPARED = 4

/**
 * Phrases that undo a reservation rather than make one.
 *
 * The ACL registers `booking.create` and `booking.reschedule` but no
 * `booking.cancel`, so a request for one is denied by `gateAction` with
 * "No action … is registered" — a denial, not a crash, which is what §18 asks of
 * an unregistered id. The point of asking anyway is that the alternative is
 * worse: a substring match on "book" turns the request into a
 * `booking.create`, and the turn reports the visitor asked to be booked.
 */
const CANCELLATION_PHRASES: readonly string[] = [
  'cancel',
  'cancellation',
  'call off',
  'call it off',
  'undo my booking',
  'undo the booking',
]

/**
 * The page entities the visitor could have meant, as the page last reported
 * them. The graph is the only source — a brain that read the tenant's catalog
 * could highlight something the page is not showing, and the page is what the
 * visitor is looking at.
 *
 * The projection hands the brain `context.entities`, not a bare array: the §16
 * boundary deliberately gives providers ids, labels and flags rather than the
 * graph itself, so this reads the labelled list rather than reaching past the
 * boundary for the thing behind it. An array at the top level would be the
 * graph leaking, not the graph being read.
 */
function pageEntities(
  entities: unknown,
): readonly { readonly id: string; readonly name: string }[] {
  const listed = Array.isArray(entities)
    ? entities
    : Array.isArray((entities as { readonly entities?: unknown } | null)?.entities)
      ? (entities as { readonly entities: readonly unknown[] }).entities
      : []
  const named: { id: string; name: string }[] = []
  for (const entity of listed) {
    if (typeof entity !== 'object' || entity === null) continue
    const record = entity as { readonly id?: unknown; readonly name?: unknown }
    if (typeof record.id !== 'string' || record.id === '') continue
    named.push({ id: record.id, name: typeof record.name === 'string' ? record.name : record.id })
  }
  return named
}

/** Escape a name so it can be matched literally inside a pattern. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The entities the utterance names, matched against the page.
 *
 * A name matches when the utterance contains it; an id matches on a word
 * boundary so `deluxe` does not match inside `deluxe-suite` twice, and — more
 * to the point — so an id does not match a substring of a different id and
 * point a highlight at the wrong element. An utterance naming nothing the page
 * shows produces an empty list, which the caller turns into a request naming
 * nothing rather than into a guess.
 */
function namedEntities(
  utterance: string,
  entities: readonly { readonly id: string; readonly name: string }[],
): readonly { readonly id: string; readonly name: string }[] {
  const text = utterance.toLowerCase()
  const matched: { id: string; name: string }[] = []
  for (const entity of entities) {
    const name = entity.name.toLowerCase()
    const id = entity.id.toLowerCase()
    const byName = name !== '' && text.includes(name)
    const byId = new RegExp(`(^|[^a-z0-9])${literal(id)}([^a-z0-9]|$)`).test(text)
    if ((byName || byId) && !matched.some((existing) => existing.id === entity.id))
      matched.push(entity)
  }
  return matched
}

/** The action an utterance asks for, or `null` when it asks for none. */
function requestedActionId(utterance: string): string | null {
  const text = utterance.toLowerCase()
  // Cancellation first, ahead of every pattern: "cancel my booking" contains
  // "booking", which contains "book", so the create pattern matches it by
  // substring and a visitor asking to undo a reservation is handed a request to
  // make one. The two are opposite intents about the same thing, so the one that
  // undoes has to be read before the one that commits.
  if (CANCELLATION_PHRASES.some((phrase) => text.includes(phrase))) return 'booking.cancel'
  for (const pattern of ACTION_PATTERNS) {
    if (pattern.phrases.some((phrase) => text.includes(phrase))) return pattern.actionId
  }
  return null
}

/**
 * The action request an utterance asks for, or `null` when it asks for none.
 *
 * Exported so a test can assert the mapping without a brain behind it: "compare"
 * against a page showing two offerings is a request for `ui.compare` over two
 * ids, and that claim is worth making directly rather than through a turn.
 */
export function requestAction(utterance: string, entities: unknown): ReferenceActionRequest | null {
  const actionId = requestedActionId(utterance)
  if (actionId === null) return null
  const visible = pageEntities(entities)
  const named = namedEntities(utterance, visible)

  switch (actionId) {
    case 'ui.compare':
      // A comparison needs two subjects. When the visitor named fewer than two,
      // what they asked for is a comparison of what is on screen, and the page
      // is the only thing that knows what that is.
      return {
        actionId,
        inputs: {
          entityIds: (named.length >= 2 ? named.slice(0, MAX_COMPARED) : visible)
            .slice(0, MAX_COMPARED)
            .map((entity) => entity.id),
        },
      }
    case 'ui.highlight':
      // A highlight of a specific element when the utterance named it, and of
      // the first visible one when it did not: an unnamed show-me is still a
      // show-me, and asking for the element is the request that lets the gate
      // and the executor say no.
      return {
        actionId,
        inputs: { entityId: (named[0] ?? visible[0])?.id },
      }
    default:
      // No page inputs. The gate decides on these two: `booking.create` waits
      // for confirmation, `payment.initiate` is above the tier. A brain that
      // pre-refused the second would be approving the first too.
      return { actionId, inputs: {} }
  }
}

/**
 * A structured-truth turn as a sentence a visitor can read.
 *
 * The inner brain answered — it was handed the live values and did not defer — so
 * what it wrote is the record, serialised. `ScriptedBrain` is deliberately
 * schema-agnostic: it can stringify a value but it cannot know that `amountMinor`
 * is money or that the price snapshot holds thirty-six nightly rates. The E2E
 * showed the result, a chat bubble containing that JSON blob. So the reference
 * tenant, which owns the schema in `./rates.js`, says it back in words.
 *
 * Only the text changes. The value still comes from the port; the turn outcome
 * still carries `structuredTruth` untouched for the audit trail, and the answer's
 * provenance (`basis: 'structured_truth'`) is unaffected, because what changed is
 * how an already-live value is phrased rather than where it came from.
 *
 * When nothing in the record can be rendered, the inner reply stands — a record
 * nobody can put into words is worse shown than swallowed.
 */
function spoken(reply: BrainReply, request: BrainTurn): BrainReply {
  if (request.knowledgeMode !== 'structured_truth') return reply
  // A reply that deferred has no values to render: the port answered nothing, and
  // rewriting the refusal would turn a "I do not know" into a sentence about
  // whatever the snapshot happens to hold.
  if (reply.deferToStructuredTruth) return reply
  const rendered = renderStructuredTruth(request.structuredTruth, request.utterance)
  if (rendered === null) return reply
  return { ...reply, text: rendered }
}

/**
 * Wrap a brain so its replies can ask for a page action.
 *
 * A decorator rather than a subclass so any adapter can wear it: the reference
 * tenant runs a scripted brain today and a network adapter tomorrow, and the
 * difference between them should not change whether a request can be made.
 */
export class ReferenceBrain implements BrainProvider {
  constructor(
    private readonly inner: BrainProvider,
    readonly providerId: string,
  ) {}

  get model(): string {
    return this.inner.model
  }

  /** The inner brain's health, unchanged. The decorator adds nothing to report. */
  get health(): unknown {
    return this.inner.health
  }

  async reply(request: BrainTurn): Promise<BrainReply> {
    const reply = await this.inner.reply(request)
    const action = requestAction(request.utterance, request.context)
    return spoken(action === null ? reply : { ...reply, requestedActions: [action] }, request)
  }
}
