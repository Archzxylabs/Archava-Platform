import type {
  DecisionOrchestrator,
  DecisionTrace,
  DecisionRun,
  DecisionBaseline,
} from '@archava/decision'
import type {
  KnowledgeClassification,
  KnowledgeContextChunk,
  StructuredTruthSubject,
} from '@archava/knowledge'

/** The decision layer receives only projected context and limited published evidence. */
export interface DecisionTurnInput {
  readonly tenantId: string
  readonly utterance: string
  readonly locale: string
  readonly context: Readonly<Record<string, unknown>>
  readonly classification: KnowledgeClassification
  readonly grounding: readonly KnowledgeContextChunk[]
  readonly handoffRequested: boolean
  readonly orchestrator?: DecisionOrchestrator
  /** Subjects supplied by trusted tenant code, never invented by a model. */
  readonly structuredTruthCandidates?: readonly StructuredTruthSubject[]
}

export interface DecisionTurnResult {
  readonly run: DecisionRun | null
  readonly classification: KnowledgeClassification
  readonly clarify: boolean
  readonly recommendHandoff: boolean
  readonly evidenceInsufficient: boolean
  readonly intent: string | null
  readonly runtimeChanged: boolean
}

/** A minimal projection for a vendor. No form values or customer state. */
export function decisionEvidence(
  context: Readonly<Record<string, unknown>>,
  grounding: readonly KnowledgeContextChunk[],
): Readonly<Record<string, unknown>> {
  return {
    page: {
      kind: context['pageKind'],
      locale: context['locale'],
      entityCount: Array.isArray(context['entities']) ? context['entities'].length : 0,
    },
    publishedEvidence: grounding.slice(0, 3).map((chunk) => ({
      sourceId: chunk.sourceId,
      text: decisionUtterance(chunk.text.slice(0, 800)),
    })),
  }
}

/** Redact common secrets and personal contact values before external evaluation. */
export function decisionUtterance(utterance: string): string {
  return utterance
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[number]')
    .replace(/\b(?:sk|pk|tok)_[A-Za-z0-9_-]{8,}\b/g, '[credential]')
    .replace(/(?:\+?\d[ -]?){10,15}/g, '[number]')
}

function baselineIntent(classification: KnowledgeClassification): DecisionBaseline {
  const subjects = classification.subjects
  const answer = subjects.includes('price')
    ? 'pricing_inquiry'
    : subjects.includes('availability') || subjects.includes('stock')
      ? 'availability_inquiry'
      : subjects.some((subject) => subject.endsWith('_status') || subject === 'customer_or_order')
        ? 'status_inquiry'
        : 'general_inquiry'
  return { task: 'intent_classification', answer, source: 'foundation_classification' }
}

/**
 * One batched evaluation. The only runtime effects are conservative: protected
 * truth cannot be downgraded, a missing truth subject cannot be invented, and
 * evidence scores can withhold an unsupported retrieval answer but not create one.
 */
export async function evaluateDecisionTurn(input: DecisionTurnInput): Promise<DecisionTurnResult> {
  if (input.orchestrator === undefined) {
    return {
      run: null,
      classification: input.classification,
      clarify: false,
      recommendHandoff: false,
      evidenceInsufficient: false,
      intent: null,
      runtimeChanged: false,
    }
  }

  const baselines: DecisionBaseline[] = [
    baselineIntent(input.classification),
    {
      task: 'knowledge_routing',
      answer: input.classification.need,
      source: 'classifyKnowledgeNeed',
    },
    { task: 'clarification', answer: false, source: 'foundation_turn' },
    { task: 'handoff_recommendation', answer: input.handoffRequested, source: 'handoffRequested' },
    {
      task: 'evidence_sufficiency',
      answer: input.grounding.length > 0 ? 1 : 0,
      source: 'retrieval_presence',
    },
  ]
  let run: DecisionRun
  try {
    run = await input.orchestrator.run(
      {
        tenantId: input.tenantId,
        utterance: decisionUtterance(input.utterance),
        locale: input.locale,
        evidence: decisionEvidence(input.context, input.grounding),
      },
      baselines,
    )
  } catch {
    // A decision integration must not interrupt the Foundation turn.
    return {
      run: null,
      classification: input.classification,
      clarify: false,
      recommendHandoff: false,
      evidenceInsufficient: false,
      intent: null,
      runtimeChanged: false,
    }
  }
  const answer = (task: DecisionBaseline['task']) =>
    run.decisions.find((item) => item.task === task)
  const route = answer('knowledge_routing')
  const candidates = input.structuredTruthCandidates ?? []
  const mayEscalate =
    input.classification.need === 'retrieval_knowledge' &&
    route?.source === 'provider' &&
    route.answer === 'structured_truth' &&
    candidates.length > 0
  const classification: KnowledgeClassification = mayEscalate
    ? {
        need: 'structured_truth',
        subjects: [...new Set(candidates)],
        matched: ['decision_escalation'],
      }
    : input.classification

  const clarify =
    answer('clarification')?.source === 'provider' && answer('clarification')?.answer === true
  const recommendHandoff =
    answer('handoff_recommendation')?.source === 'provider' &&
    answer('handoff_recommendation')?.answer === true
  const evidence = answer('evidence_sufficiency')
  const evidenceInsufficient =
    classification.need === 'retrieval_knowledge' &&
    input.grounding.length > 0 &&
    evidence?.source === 'provider' &&
    typeof evidence.answer === 'number' &&
    evidence.answer < 0.5
  const intent = answer('intent_classification')?.answer
  const runtimeChanged = Boolean(mayEscalate || clarify || recommendHandoff || evidenceInsufficient)
  return {
    run,
    classification,
    clarify,
    recommendHandoff,
    evidenceInsufficient,
    intent: typeof intent === 'string' ? intent : null,
    runtimeChanged,
  }
}

export type DecisionObservation = DecisionTrace & { readonly runtimeChanged: boolean }
