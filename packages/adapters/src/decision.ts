/**
 * Bounded fuzzy judgment, behind a port that is not a language model.
 *
 * The turn pipeline has three places today where it has to decide something, and
 * two of the three are deterministic code: {@link classifyKnowledgeNeed} routes a
 * question to a live system or to retrieval (PRD §17), and the brain answers. The
 * first can say *why* — it returns the keywords that fired, so the audit trail
 * names the words the visitor used. A model can say only that it felt confident.
 *
 * That is the gap this port fills, and it is narrow on purpose. It answers
 * *bounded* questions — Boolean, Choice, Score — over facts it was handed, and it
 * reports how confident it was. It does not write prose. It does not pick an
 * action. It does not read a clock. It is a judge, not an author, and the split
 * from {@link BrainProvider} is what keeps it that way.
 *
 * Why it is not `BrainProvider` with a different prompt: the brain's whole job is
 * to produce something a visitor reads. Everything downstream of it assumes
 * prose, or an action request, or a citation. A judgment is none of those, and
 * routing it through a port that returns text would mean parsing text back into
 * a boolean at every call site — with the parse failure being the kind that
 * silently reads as `false`. So it is a separate port that returns typed
 * decisions, and the difference is visible in the import list.
 */

/** The kinds of bounded decision a provider may answer. */
export const DECISION_KINDS = ['boolean', 'choice', 'score'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** A bounded question, with its answer set closed in advance. */
export interface DecisionQuestion {
  /** Stable id. The task registry owns it; a provider never invents one. */
  readonly id: string
  readonly kind: DecisionKind
  /**
   * The question as a provider with no tenant context reads it.
   *
   * A provider is handed ids and labels, never the tenant's schema, so the
   * prompt is the only thing it has to go on — which means the prompt has to
   * carry the question rather than point at a column name that means nothing
   * outside this tenant.
   */
  readonly prompt: string
  /** The closed answer set. Required for `choice`, ignored otherwise. */
  readonly options?: readonly string[]
  /** The inclusive numeric bounds. Required for `score`, ignored otherwise. */
  readonly bounds?: readonly [number, number]
}

/** What a provider is asked. Assembled by the caller, never by the model. */
export interface DecisionRequest {
  readonly tenantId: string
  /**
   * The visitor utterance the decision is about.
   *
   * The utterance is the input in every task, because every task in the initial
   * set is a reading of what someone said. The evidence around it is what the
   * platform already had on hand.
   */
  readonly utterance: string
  readonly locale: string
  /**
   * §16-masked facts a decision may weigh.
   *
   * The same discipline as {@link BrainTurn.context}: whatever is here has
   * already been through the field masker, so a provider cannot be handed a
   * secret because a caller forgot to strip it.
   *
   * An evidence-sufficiency caller may include bounded excerpts from published
   * retrieval content. These remain evidence to judge, never authoritative
   * transactional facts. The caller must project and redact them first.
   */
  readonly evidence: Readonly<Record<string, unknown>>
  readonly questions: readonly DecisionQuestion[]
}

/**
 * One bounded answer, with the confidence attached.
 *
 * A discriminated union rather than a bag of optional fields, because an answer
 * of the wrong kind is not a wrong answer — it is an answer to a different
 * question. `answer: unknown` would let that through to the consumer, which is
 * where it would then be read as `false`.
 */
export type Decision =
  | {
      readonly id: string
      readonly kind: 'boolean'
      readonly answer: boolean
      /** Bounded 0..1. A provider that cannot answer reports a refusal instead. */
      readonly confidence: number
    }
  | {
      readonly id: string
      readonly kind: 'choice'
      readonly answer: string
      /** Bounded 0..1. An answer outside `options` is a refusal's neighbour. */
      readonly confidence: number
    }
  | {
      readonly id: string
      readonly kind: 'score'
      readonly answer: number
      /** Bounded 0..1. A number outside `bounds` is a refusal's neighbour. */
      readonly confidence: number
    }

/** Why a provider did not answer one question. */
export interface DecisionRefusal {
  readonly id: string
  /**
   * Free text, deliberately.
   *
   * A closed vocabulary here would mean either a catch-all nobody learns to read
   * or a new shared entry for every provider's particular failure. This is a
   * provider's own account of itself and it goes into the audit trail, where a
   * specific sentence is worth more than a tidy code.
   */
  readonly reason: string
}

/** What a provider produced. */
export interface DecisionResult {
  readonly providerId: string
  /** Model identity for the audit trail. A name, never a credential. */
  readonly model: string
  readonly decisions: readonly Decision[]
  readonly refused: readonly DecisionRefusal[]
}

/** Whether a provider can serve at all. */
export interface DecisionHealth {
  readonly ready: boolean
  readonly reason: string | null
}

/**
 * The port.
 *
 * Async by construction, and for the same reason {@link BrainProvider} is: the
 * honest port for a bounded judgment that costs a network call is one that can
 * fail without anyone holding an event loop hostage. Determinism in this repo is
 * not the absence of IO — it is that everything the call depends on is an explicit
 * argument. {@link DecisionRequest} is that argument list, and a provider that
 * reaches past it for a clock, a store, or a tenant's schema is the thing this
 * shape exists to catch.
 *
 * Implementations must be side-effect free with respect to the platform. They
 * may call a model; they must not write to a store, dispatch an action, or mutate
 * their arguments. Anything with an effect belongs behind an action, where the
 * policy gate can see it.
 */
export interface DecisionProvider {
  readonly providerId: string
  /** Model identity for the audit trail. A name, never a credential. */
  readonly model: string
  readonly health: unknown
  decide(request: DecisionRequest): Promise<DecisionResult>
}

/** A misconfigured provider, as opposed to one that merely could not answer. */
export class DecisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionError'
  }
}

/**
 * Why a question cannot be answered in the shape it was given, or `null` when it
 * is well-formed.
 *
 * Callers check this so a malformed question fails loudly at the boundary
 * instead of reaching a provider that will either guess or return a refusal the
 * caller cannot interpret. Each rule is the one that makes its kind meaningful:
 * a `choice` with no options is a question with no answer set; a `score` with
 * reversed bounds is a range with no interior.
 *
 * Not a thrown error because the caller wants to name *which* question was
 * malformed, and a specific sentence beats a stack.
 */
export function decisionQuestionProblem(question: DecisionQuestion): string | null {
  if (question.id.trim() === '') return 'A decision question needs a stable id.'
  if (question.prompt.trim() === '') return `Question "${question.id}" needs a prompt.`
  if (question.kind === 'choice' && (question.options ?? []).length === 0) {
    return `Question "${question.id}" is a choice with no options; a closed answer set is the whole point.`
  }
  if (question.kind === 'score') {
    const bounds = question.bounds
    if (bounds === undefined) return `Question "${question.id}" is a score with no bounds.`
    if (bounds[0] > bounds[1]) {
      return `Question "${question.id}" has bounds ${bounds[0]}..${bounds[1]}; the range is empty.`
    }
  }
  return null
}
