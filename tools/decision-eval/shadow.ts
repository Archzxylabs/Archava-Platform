/** Explicit SHADOW evaluation over synthetic corpus entries. No network in this module. */
import type { DecisionProvider } from '@archava/adapters'
import {
  DecisionOrchestrator,
  type DecisionBaseline,
  type DecisionTrace,
  type DecisionTask,
} from '@archava/decision'
import { classifyKnowledgeNeed } from '@archava/knowledge'
import { REFERENCE_CORPUS, type EvaluationCase } from './corpus.js'
import { scorePredictions, type EvaluationReport, type Predictions } from './metrics.js'

const SCORED_TASKS: readonly DecisionTask[] = [
  'intent_classification',
  'knowledge_routing',
  'clarification',
  'handoff_recommendation',
]

export interface ShadowEvaluationOptions {
  readonly cases?: readonly EvaluationCase[]
  readonly maxCases?: number
  readonly paceMs?: number
  readonly timeoutMs?: number
}

export interface ShadowEvaluationResult {
  readonly casesRun: number
  readonly languages: Readonly<Record<string, number>>
  readonly providerCalls: number
  readonly raw: EvaluationReport
  readonly effective: EvaluationReport
  readonly traceCounts: Readonly<Record<string, number>>
  readonly caseTraces: readonly ShadowCaseTrace[]
  readonly disagreements: number
  readonly fallbacks: number
  readonly transportOrSchemaFailures: number
  readonly refusals: number
  readonly shadowChangedRuntime: false
}

/** Metadata only: synthetic case id and bounded answers, never utterance/evidence. */
export interface ShadowCaseTrace {
  readonly caseId: string
  readonly task: DecisionTask
  readonly outcome: DecisionTrace['outcome']
  readonly candidate: string | null
  readonly confidence: number | null
  readonly effective: string | null
  readonly disagreement: boolean
  readonly wouldApply: boolean
  readonly latencyMs: number | null
}

/** Round robin keeps short smoke runs multilingual instead of English-only. */
export function selectCases(cases: readonly EvaluationCase[], maxCases: number): EvaluationCase[] {
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > cases.length) {
    throw new Error('maxCases must be an integer between 1 and the corpus size')
  }
  const locales: readonly EvaluationCase['locale'][] = ['en', 'id', 'mixed']
  const buckets = locales.map((locale) => cases.filter((item) => item.locale === locale))
  if (buckets.reduce((sum, bucket) => sum + bucket.length, 0) < maxCases) {
    throw new Error('Corpus contains unsupported locales')
  }
  const selected: EvaluationCase[] = []
  let cursor = 0
  while (selected.length < maxCases) {
    const bucket = buckets[cursor % buckets.length]
    const next = bucket?.shift()
    if (next !== undefined) selected.push(next)
    cursor += 1
  }
  return selected
}

/**
 * The same deterministic baselines the assistant currently builds for these
 * four tasks. Routing comes from the Foundation classifier. The synthetic
 * harness has no host handoff flag, so its baseline is false.
 */
function baselinesFor(utterance: string): readonly DecisionBaseline[] {
  const classification = classifyKnowledgeNeed(utterance)
  const subjects = classification.subjects
  const intent = subjects.includes('price')
    ? 'pricing_inquiry'
    : subjects.includes('availability') || subjects.includes('stock')
      ? 'availability_inquiry'
      : subjects.some((subject) => subject.endsWith('_status') || subject === 'customer_or_order')
        ? 'status_inquiry'
        : 'general_inquiry'
  return [
    { task: 'intent_classification', answer: intent, source: 'foundation_classification' },
    { task: 'knowledge_routing', answer: classification.need, source: 'classifyKnowledgeNeed' },
    { task: 'clarification', answer: false, source: 'foundation_turn' },
    { task: 'handoff_recommendation', answer: false, source: 'handoffRequested' },
  ]
}

function label(trace: DecisionTrace, candidate: boolean): string | undefined {
  const answer = candidate ? trace.candidate?.answer : trace.effective.answer
  if (answer === undefined) return undefined
  if (trace.task === 'knowledge_routing') {
    return answer === 'retrieval_knowledge' ? 'retrieval' : String(answer)
  }
  if (trace.task === 'clarification') return answer === true ? 'clarify' : 'answer'
  if (trace.task === 'handoff_recommendation') return answer === true ? 'handoff' : 'self_serve'
  return typeof answer === 'string' ? answer : undefined
}

/** Evidence labels are unscored: these 51 utterances have no evidence payload. */
function withoutUnsupportedEvidence(cases: readonly EvaluationCase[]): EvaluationCase[] {
  return cases.map((item) => {
    const expected = { ...item.expected }
    delete expected.evidence_sufficiency
    return { ...item, expected }
  })
}

export async function evaluateShadow(
  provider: DecisionProvider,
  options: ShadowEvaluationOptions = {},
): Promise<ShadowEvaluationResult> {
  const corpus = options.cases ?? REFERENCE_CORPUS
  const selected = selectCases(corpus, options.maxCases ?? Math.min(5, corpus.length))
  const paceMs = options.paceMs ?? 0
  if (!Number.isInteger(paceMs) || paceMs < 0 || paceMs > 60_000) {
    throw new Error('paceMs must be an integer from 0 to 60000')
  }
  let providerCalls = 0
  const countedProvider: DecisionProvider = {
    providerId: provider.providerId,
    model: provider.model,
    get health() {
      return provider.health
    },
    decide(request) {
      providerCalls += 1
      return provider.decide(request)
    },
  }
  const orchestrator = new DecisionOrchestrator({
    mode: 'shadow',
    provider: countedProvider,
    enabledTasks: SCORED_TASKS,
    timeoutMs: options.timeoutMs ?? 4_500,
  })
  const raw: Record<string, Predictions> = {}
  const effective: Record<string, Predictions> = {}
  const traceCounts: Record<string, number> = {}
  const caseTraces: ShadowCaseTrace[] = []
  const languages: Record<string, number> = {}
  let disagreements = 0
  let fallbacks = 0
  let failures = 0
  let refusals = 0

  for (const [index, item] of selected.entries()) {
    const run = await orchestrator.run(
      {
        tenantId: 'synthetic-eval',
        utterance: item.utterance,
        locale: item.locale,
        evidence: { page: { kind: 'synthetic-reference', locale: item.locale, entityCount: 0 } },
      },
      baselinesFor(item.utterance),
    )
    languages[item.locale] = (languages[item.locale] ?? 0) + 1
    const rawCase: Predictions = {}
    const effectiveCase: Predictions = {}
    raw[item.id] = rawCase
    effective[item.id] = effectiveCase
    let caseFailed = false
    for (const trace of run.traces) {
      if (trace.applied || trace.effective.source !== 'baseline') {
        throw new Error('SHADOW invariant failed: provider result changed the effective answer')
      }
      traceCounts[trace.outcome] = (traceCounts[trace.outcome] ?? 0) + 1
      if (trace.agreement !== null && trace.agreement !== 'equal') disagreements += 1
      if (trace.candidate === null) fallbacks += 1
      if (
        trace.outcome === 'failed' ||
        trace.outcome === 'timeout' ||
        trace.outcome === 'malformed'
      ) {
        caseFailed = true
      }
      if (trace.outcome === 'refused') refusals += 1
      const rawLabel = label(trace, true)
      const effectiveLabel = label(trace, false)
      caseTraces.push({
        caseId: item.id,
        task: trace.task,
        outcome: trace.outcome,
        candidate: rawLabel ?? null,
        confidence: trace.confidence,
        effective: effectiveLabel ?? null,
        disagreement: trace.agreement !== null && trace.agreement !== 'equal',
        wouldApply: trace.wouldApply,
        latencyMs: trace.latencyMs,
      })
      if (rawLabel !== undefined) rawCase[trace.task] = rawLabel
      if (effectiveLabel !== undefined) effectiveCase[trace.task] = effectiveLabel
    }
    if (caseFailed) failures += 1
    if (paceMs > 0 && index < selected.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, paceMs))
    }
  }
  const scored = withoutUnsupportedEvidence(selected)
  return {
    casesRun: selected.length,
    languages,
    providerCalls,
    raw: scorePredictions(scored, raw),
    effective: scorePredictions(scored, effective),
    traceCounts,
    caseTraces,
    disagreements,
    fallbacks,
    transportOrSchemaFailures: failures,
    refusals,
    shadowChangedRuntime: false,
  }
}
