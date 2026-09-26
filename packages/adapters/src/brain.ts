/**
 * The brain port: which model reasons over a turn.
 *
 * PRD §21 puts the model behind an adapter ("Gemini Live-class brain through an
 * adapter"), and that sentence contains the whole design: the platform depends on
 * what it needs a brain to *do*, and the vendor identity lives in the adapter
 * that satisfies it. Nothing here names a model or a vendor, which is what makes
 * "swap the model" a registration change rather than a rewrite.
 *
 * The port is async, and that is not a concession — it is the whole point. A
 * brain is a network call: a vendor SDK that streams, a gateway that times out,
 * a queue that drains seconds later. A synchronous port would force one of two
 * lies on every adapter: either block the event loop inside `reply` (which the
 * platform has no right to do to whatever else is running), or return a
 * placeholder and describe it later as though it were the answer.
 *
 * What makes a turn *replayable* is not the absence of IO; it is that everything
 * the turn depends on is an explicit argument. The turn request names the
 * tenant, session, graph, occurrence timestamp, capability, role, and ports.
 * Nothing reads a clock, and nothing consults a random source. Given the same
 * arguments the turn produces the same outcome — which is a stronger claim than
 * "it never awaits", because it survives a real adapter.
 *
 * An adapter is therefore free to buffer, stream, fan out, or retry internally.
 * It owes the caller exactly one thing: a complete {@link BrainReply}, or a
 * {@link BrainError}, never a partial promise.
 */

/** A knowledge chunk as it crosses into the brain. */
export interface BrainGrounding {
  readonly sourceId: string
  readonly sourceTitle: string
  readonly sourceKind: string
  readonly text: string
}

/** The turn a brain receives. Assembled by the caller, never by the model. */
export interface BrainTurn {
  /** Tenant scope. A brain must never see a turn it cannot attribute (§23). */
  readonly tenantId: string
  /** The visitor's utterance, verbatim. */
  readonly utterance: string
  /** Locale of the page the utterance came from. */
  readonly locale: string
  /**
   * Masked page context. The caller has already applied §16 masking; this port
   * consumes masked data and is never a second place to trust.
   */
  readonly context: Readonly<Record<string, unknown>>
  /**
   * Knowledge chunks prepared for grounding, provenance intact.
   *
   * Chunks are tenant-authored published content and are *not* masked (see the
   * note in `@archava/knowledge`'s retrieval module): the masker works on field
   * names, and a chunk has none.
   */
  readonly grounding: readonly BrainGrounding[]
  /** Action ids the caller has already allowed for this turn (§18). */
  readonly permittedActionIds: readonly string[]
  /**
   * Live, authoritative values for this turn (PRD §17), already resolved by the
   * caller. Empty when nothing was resolved.
   *
   * This is the field that keeps a price honest. A brain handed `structuredTruth`
   * answers from it; a brain handed nothing must say it does not know. It is
   * never handed stale retrieval to stand in for a value it does not have.
   */
  readonly structuredTruth: Readonly<Record<string, unknown>>
  /**
   * What the caller decided this turn is grounded in, after classifying the
   * utterance (§17). It is a statement of fact about the turn, not a request —
   * the brain cannot widen it.
   *
   * - `structured_truth` — live values were resolved and are in `structuredTruth`; `grounding`
   *   is empty, because a stale chunk must not be offered as a competing source
   *   for a live price, stock level, booking state, payment, order, or account.
   *   The withholding is `runTurn`'s, not this field's: it chooses
   *   `retrievalForBrain` before calling a provider, so a provider does not have
   *   to know to discard what it was handed.
   * - `retrieval` — the question is not a live-value question, and `grounding`
   *   carries the tenant's published content.
   * - `none` — the caller had nothing trustworthy to hand over, because the live
   *   system was unreachable or the question was not answerable. The expected
   *   answer is a refusal, not a guess — and `grounding` is empty here too, for
   *   the same reason: an unanswered live-value question is not answered from a
   *   chunk either.
   */
  readonly knowledgeMode: BrainKnowledgeMode
}

/**
 * Which knowledge source is authorised to ground a turn (PRD §17).
 *
 * `structured_truth` outranks `retrieval`: when a live system has spoken, nothing
 * else may be treated as authoritative for the same fact.
 */
export const BRAIN_KNOWLEDGE_MODES = ['structured_truth', 'retrieval', 'none'] as const
export type BrainKnowledgeMode = (typeof BRAIN_KNOWLEDGE_MODES)[number]

/** An action a brain is asking to run. */
export interface BrainActionRequest {
  readonly actionId: string
  readonly inputs: Readonly<Record<string, unknown>>
}

/** What a brain produced. */
export interface BrainReply {
  /**
   * The prose answer. Empty when the turn produced only actions, or when the
   * brain declined and the caller must answer from structured truth instead.
   */
  readonly text: string
  /**
   * Actions the brain wants to take. These are *requests*, not permissions: the
   * policy gate re-evaluates every one, because a model that has selected an
   * action id has not thereby earned the role to run it (§18).
   */
  readonly requestedActions: readonly BrainActionRequest[]
  /**
   * Provenance of the sources the answer rested on, for §17's debug/eval trail.
   */
  readonly citations: readonly { readonly sourceId: string; readonly sourceTitle: string }[]
  /** True when the brain could not answer and the caller must use live data. */
  readonly deferToStructuredTruth: boolean
  /**
   * Generative UI the brain selected, as *unvalidated* payloads (§25).
   *
   * Deliberately `unknown[]`: a brain that invents a component kind it was never
   * offered must be rejected at the boundary, not trusted to the type. The
   * assistant validates every entry against the registry's prop schemas and
   * narrows it to `GenerativeComponent`; what survives the registry is what the
   * client draws. Nothing here is evaluated as code.
   */
  readonly components?: readonly unknown[]
}

/** Whether a brain can serve at all. */
export interface BrainHealth {
  readonly ready: boolean
  /** Present when `ready` is false; the reason a fallback would be chosen. */
  readonly reason: string | null
}

/**
 * A brain: given a turn, produce a reply.
 *
 * Implementations must be side-effect free with respect to the platform. They may
 * call a model, but they must not write to a store, dispatch an action, or mutate
 * their arguments. Anything with an effect belongs behind an action, where the
 * policy gate can see it.
 *
 * Async by construction. See the module header: a brain is a network call, and
 * the only honest port for a network call is one that can fail without anyone
 * holding an event loop hostage.
 */
export interface BrainProvider {
  readonly providerId: string
  /** Model identity for the audit trail. A name, never a credential. */
  readonly model: string
  readonly health: unknown
  reply(turn: BrainTurn): Promise<BrainReply>
}

export class BrainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrainError'
  }
}

/**
 * A deterministic reference brain: no model, no network, no clock.
 *
 * This exists so the turn pipeline can be built, tested, and demoed end to end
 * before any provider credential exists, and so the reference implementation
 * (the config whose `isReferenceImplementation` flag is set) runs offline. It
 * answers from the tenant's own authored knowledge and from nothing else.
 *
 * When it cannot answer from what it was handed, it says so rather than inventing
 * an answer — the same discipline the real model is held to by §17.
 */
export class ScriptedBrain implements BrainProvider {
  readonly model = 'deterministic-reference'

  constructor(
    private readonly options: {
      readonly providerId: string
      /** Exact answer text, keyed by a lowercased substring of the utterance. */
      readonly answers?: Readonly<Record<string, string>>
      /** Reply used when nothing in `answers` matches and there is no grounding. */
      readonly fallback?: string
    },
  ) {}

  get providerId(): string {
    return this.options.providerId
  }

  get health(): unknown {
    return { ready: true, reason: null } satisfies BrainHealth
  }

  reply(turn: BrainTurn): Promise<BrainReply> {
    // §17, first and ahead of everything else: the caller classified this turn as a
    // live-value question, so live values are the only authorised answer and nothing
    // may compete with them — not a script, not a chunk. A script quoting a price is
    // quoting the price from when the script was written, and handing a visitor that
    // instead of the live one is exactly the failure §17 exists to prevent, so the
    // script loses this comparison.
    //
    // Values are usually present, because the caller resolved them before asking. When
    // they are absent the answer is a refusal: retrieval was withheld on purpose, since
    // a stale chunk must not be offered as a competing source for a live price, stock
    // level, booking state, payment, order, or account. Deferring lets the pipeline
    // report the gap rather than let this brain paper over it.
    if (turn.knowledgeMode === 'structured_truth') {
      const entries = Object.entries(turn.structuredTruth)
      if (entries.length === 0) {
        return Promise.resolve({
          text: this.options.fallback ?? 'I do not have a live value for that, so I cannot answer.',
          requestedActions: [],
          citations: [],
          deferToStructuredTruth: true,
        })
      }
      return Promise.resolve({
        text: entries.map(([key, value]) => `${key}: ${describe(value)}`).join('; '),
        requestedActions: [],
        citations: [],
        deferToStructuredTruth: false,
      })
    }

    const probe = turn.utterance.toLowerCase()
    for (const [needle, answer] of Object.entries(this.options.answers ?? {})) {
      if (probe.includes(needle.toLowerCase())) {
        return Promise.resolve({
          text: answer,
          requestedActions: [],
          citations: cite(turn.grounding),
          deferToStructuredTruth: false,
        })
      }
    }

    // Answering from grounding when retrieval found something is the honest
    // middle: it is authored content, not a model guess. On a structured-truth
    // turn there is no grounding to fall back on, which is exactly the point of
    // §17 — a price question with no live answer must produce a refusal.
    //
    // That sentence describes the *pipeline*, not a defensive assumption here:
    // `runTurn` withholds grounding on a structured-truth turn (turn.ts, where
    // `retrievalForBrain` is chosen). If a caller ever starts handing it over
    // again, this branch silently starts quoting stale chunks under a live-value
    // turn — so the withholding is the invariant, and this is only its consumer.
    const first = turn.grounding[0]
    if (first) {
      return Promise.resolve({
        text: first.text,
        requestedActions: [],
        citations: cite(turn.grounding),
        deferToStructuredTruth: false,
      })
    }

    return Promise.resolve({
      text: this.options.fallback ?? 'I do not have enough information to answer that.',
      requestedActions: [],
      citations: [],
      deferToStructuredTruth: true,
    })
  }
}

/**
 * One resolved value as a sentence fragment, deterministically.
 *
 * Primitives read as themselves; anything else is serialised rather than
 * interpolated, because `[object Object]` is an answer that looks like an answer
 * and is not one.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function cite(
  grounding: readonly BrainGrounding[],
): readonly { sourceId: string; sourceTitle: string }[] {
  return grounding.map((chunk) => ({ sourceId: chunk.sourceId, sourceTitle: chunk.sourceTitle }))
}
