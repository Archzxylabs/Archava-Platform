/**
 * The brain port: which model reasons over a turn.
 *
 * PRD §21 puts the model behind an adapter ("Gemini Live-class brain through an
 * adapter"), and that sentence contains the whole design: the platform depends on
 * what it needs a brain to *do*, and the vendor identity lives in the adapter
 * that satisfies it. Nothing here names a model or a vendor, which is what makes
 * "swap the model" a registration change rather than a rewrite.
 *
 * The port is synchronous, a deliberate departure from how vendor SDKs are
 * shaped. Two reasons:
 *
 * 1. Every module this package composes with — the context graph reducer, the
 *    knowledge store, the policy gate — is a pure function. An async port would
 *    force every caller to become async and put `await` boundaries inside the
 *    deterministic turn pipeline.
 * 2. A brain that must be awaited introduces a second source of nondeterminism:
 *    ordering. Two synchronous turns always compose in the same order; two
 *    awaited ones do not, unless the caller maintains that order by hand.
 *
 * A real adapter bridges this: it buffers the provider's stream and exposes the
 * completed turn on the same synchronous surface. Buffering is the adapter's
 * problem, not the pipeline's.
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
}

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
 */
export interface BrainProvider {
  readonly providerId: string
  /** Model identity for the audit trail. A name, never a credential. */
  readonly model: string
  readonly health: unknown
  reply(turn: BrainTurn): BrainReply
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

  reply(turn: BrainTurn): BrainReply {
    const probe = turn.utterance.toLowerCase()
    for (const [needle, answer] of Object.entries(this.options.answers ?? {})) {
      if (probe.includes(needle.toLowerCase())) {
        return {
          text: answer,
          requestedActions: [],
          citations: cite(turn.grounding),
          deferToStructuredTruth: false,
        }
      }
    }

    // Answering from grounding when retrieval found something is the honest
    // middle: it is authored content, not a model guess.
    const first = turn.grounding[0]
    if (first) {
      return {
        text: first.text,
        requestedActions: [],
        citations: cite(turn.grounding),
        deferToStructuredTruth: false,
      }
    }

    return {
      text: this.options.fallback ?? 'I do not have enough information to answer that.',
      requestedActions: [],
      citations: [],
      deferToStructuredTruth: true,
    }
  }
}

function cite(
  grounding: readonly BrainGrounding[],
): readonly { sourceId: string; sourceTitle: string }[] {
  return grounding.map((chunk) => ({ sourceId: chunk.sourceId, sourceTitle: chunk.sourceTitle }))
}
