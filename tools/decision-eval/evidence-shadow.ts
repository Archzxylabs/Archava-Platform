/**
 * Offline SHADOW evaluation over the labelled evidence-sufficiency set.
 *
 * Same shape as `shadow.ts`, one task wide. That harness deliberately scores
 * nothing for evidence, because its 51 utterances have no evidence to judge;
 * this one runs the other 28 cases that do. Keeping the two apart is the point:
 * a reference-corpus case whose `evidence_sufficiency` label describes the
 * tenant's knowledge rather than any supplied facts would, if folded in, turn a
 * provider's coverage score into a verdict on the tenant.
 *
 * The provider is asked exactly one question per case — "how much of the answer
 * do the supplied facts already cover, from 0 to 1" — and its answer reaches
 * nowhere. SHADOW holds both invariants the orchestrator enforces (`applied`
 * false, effective answer from the baseline), so the number a live provider
 * returns can be measured and cannot move a turn. That is what makes it safe to
 * point this at the real one.
 *
 * What is measured against what: the mock or live answer is scored against the
 * label each case carries, per locale and per hazard. The deterministic
 * baseline is scored the same way and returned alongside it, so "the provider
 * was right 19 times" is never read without "the baseline was right 9 times".
 */

import type { DecisionProvider } from '@archava/adapters'
import { DecisionOrchestrator, type DecisionBaseline, type DecisionTrace } from '@archava/decision'
import type { CorpusLocale } from './corpus.js'
import {
  EVIDENCE_HAZARDS,
  EVIDENCE_SET,
  type EvidenceCase,
  evidenceRequest,
} from './evidence-set.js'
import {
  scoreEvidencePredictions,
  type EvidencePrediction,
  type EvidenceReport,
} from './evidence-metrics.js'

/**
 * The only task this harness asks about: one question, one call, one case.
 *
 * Narrowed to the literal rather than `DecisionTask` so the baseline built from
 * it satisfies `DecisionBaseline`, which is distributed over each task rather
 * than indexed by the union.
 */
const EVIDENCE_TASK = 'evidence_sufficiency' as const

/**
 * Where a coverage score becomes a verdict, restated rather than imported.
 *
 * The consumer in `packages/assistant/src/decision.ts` treats `answer < 0.5` as
 * insufficient, and the offline `run-rule.ts` labels the same way. That number is
 * load-bearing production behaviour which the package that owns it deliberately
 * does not export, so this tool restates it instead of reaching into an
 * internals path that would make the eval unrunnable in a half-built repository.
 */
const SUFFICIENT_THRESHOLD = 0.5

export interface EvidenceShadowOptions {
  readonly cases?: readonly EvidenceCase[]
  readonly maxCases?: number
  readonly paceMs?: number
  readonly timeoutMs?: number
}

/**
 * Metadata about one judged case. Never the question, never an excerpt: the
 * committed set already holds those against the case id, and a trace is for
 * reporting what a provider did, not for duplicating the tenant's content.
 */
export interface EvidenceCaseTrace {
  readonly caseId: string
  readonly hazard: EvidenceCase['hazard']
  readonly liveSubject: EvidenceCase['liveSubject']
  readonly expected: string
  readonly outcome: DecisionTrace['outcome']
  /** The score the provider returned, when it returned one. */
  readonly candidate: number | null
  readonly confidence: number | null
  /** The label the deterministic baseline produced, which is what a turn uses. */
  readonly effective: string
  readonly disagreement: boolean
  readonly wouldApply: boolean
  readonly latencyMs: number | null
}

export interface EvidenceShadowResult {
  readonly casesRun: number
  readonly languages: Readonly<Record<string, number>>
  readonly providerCalls: number
  /** Scored on what the provider said, never on what a turn would do with it. */
  readonly raw: EvidenceReport
  /** Scored on the deterministic baseline, which is what a turn actually does. */
  readonly effective: EvidenceReport
  readonly traceCounts: Readonly<Record<string, number>>
  readonly evidenceTraces: readonly EvidenceCaseTrace[]
  readonly disagreements: number
  readonly fallbacks: number
  readonly transportOrSchemaFailures: number
  readonly refusals: number
  readonly malformed: number
  readonly shadowChangedRuntime: false
}

/**
 * One locale's cases, interleaved across hazards rather than grouped by them.
 *
 * Taking the set as written would put three `supported` cases at the head of
 * every language, so a nine-case run built from the head of each is nine cases
 * of one hazard and one label — a number about one corner of the set.
 * Round-robin across hazard queues puts one case of each kind before a second
 * of any, so a short run still measures several kinds of insufficiency.
 */
function interleavedByHazard(cases: readonly EvidenceCase[], locale: CorpusLocale): EvidenceCase[] {
  const inLocale = cases.filter((evaluationCase) => evaluationCase.locale === locale)
  const buckets = EVIDENCE_HAZARDS.map((hazard) =>
    inLocale.filter((evaluationCase) => evaluationCase.hazard === hazard),
  )
  const interleaved: EvidenceCase[] = []
  for (let round = 0; buckets.some((bucket) => round < bucket.length); round += 1) {
    for (const bucket of buckets) {
      const next = bucket[round]
      if (next !== undefined) interleaved.push(next)
    }
  }
  return interleaved
}

/** The label a coverage score claims. */
export function labelForScore(score: number): 'sufficient' | 'insufficient' {
  return score >= SUFFICIENT_THRESHOLD ? 'sufficient' : 'insufficient'
}

/**
 * Round-robin over the three languages, interleaved by hazard inside each one.
 *
 * One case per language per pass keeps the language counts even, and each
 * locale's own order walks its hazards. What a nine-case run measures is
 * diversity of hazard and label, not more of the case at the head of the list.
 */
export function selectEvidenceCases(
  cases: readonly EvidenceCase[],
  maxCases: number,
): EvidenceCase[] {
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > cases.length) {
    throw new Error(`maxCases must be an integer between 1 and ${cases.length}`)
  }
  const locales: readonly CorpusLocale[] = ['en', 'id', 'mixed']
  const queues = locales.map((locale) => interleavedByHazard(cases, locale))
  if (queues.reduce((sum, queue) => sum + queue.length, 0) < maxCases) {
    throw new Error('the evidence set contains an unsupported locale')
  }
  const selected: EvidenceCase[] = []
  let cursor = 0
  while (selected.length < maxCases) {
    const next = queues[cursor % locales.length]?.shift()
    if (next !== undefined) selected.push(next)
    cursor += 1
  }
  return selected
}

/**
 * The deterministic baseline: whether any fact was supplied at all.
 *
 * Mirrors the production baseline's shape rather than its numbers
 * (`input.grounding.length > 0 ? 1 : 0`, source `retrieval_presence`).
 *
 * This is deliberately the floor, and a provider is supposed to beat it: the
 * only cases it gets right are the ones where retrieval found nothing, and it
 * is wrong on every `supported` case in the set, because a supplied fact is not
 * always the answer to the question asked. A baseline that judged the supplied
 * facts as well as a provider claims to would be a baseline nobody needs, and
 * the number that separates them is the whole reason to run this.
 */
function baselineFor(evaluationCase: EvidenceCase): readonly DecisionBaseline[] {
  return [
    {
      task: EVIDENCE_TASK,
      answer: evaluationCase.excerpts.length > 0 ? 1 : 0,
      source: 'retrieval_presence' as const,
    },
  ]
}

export async function evaluateEvidenceShadow(
  provider: DecisionProvider,
  options: EvidenceShadowOptions = {},
): Promise<EvidenceShadowResult> {
  const cases = options.cases ?? EVIDENCE_SET
  const selected = selectEvidenceCases(cases, options.maxCases ?? Math.min(9, cases.length))
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
    enabledTasks: [EVIDENCE_TASK],
    timeoutMs: options.timeoutMs ?? 4_500,
  })

  const raw: Record<string, EvidencePrediction> = {}
  const effective: Record<string, EvidencePrediction> = {}
  const traceCounts: Record<string, number> = {}
  const evidenceTraces: EvidenceCaseTrace[] = []
  const languages: Record<string, number> = {}
  let disagreements = 0
  let fallbacks = 0
  let failures = 0
  let refusals = 0
  let malformed = 0

  for (const [index, evaluationCase] of selected.entries()) {
    const run = await orchestrator.run(
      {
        tenantId: 'synthetic-eval',
        utterance: evaluationCase.question,
        locale: evaluationCase.locale,
        // Spread so a fresh literal crosses the wide `evidence` boundary the
        // request type declares; the projection stays precisely typed for the
        // test that reads it back.
        evidence: { ...evidenceRequest(evaluationCase) },
      },
      baselineFor(evaluationCase),
    )
    languages[evaluationCase.locale] = (languages[evaluationCase.locale] ?? 0) + 1

    let trace: DecisionTrace | undefined
    for (const candidate of run.traces) {
      if (candidate.applied || candidate.effective.source !== 'baseline') {
        throw new Error('SHADOW invariant failed: a provider answer reached the effective answer')
      }
      if (candidate.task !== EVIDENCE_TASK) {
        throw new Error('the evidence harness was asked about a task it does not score')
      }
      trace = candidate
    }
    if (trace === undefined) throw new Error(`no trace came back for ${evaluationCase.id}`)

    traceCounts[trace.outcome] = (traceCounts[trace.outcome] ?? 0) + 1
    if (trace.outcome === 'failed' || trace.outcome === 'timeout') failures += 1
    if (trace.outcome === 'malformed') malformed += 1
    if (trace.outcome === 'refused') refusals += 1
    if (trace.candidate === null) fallbacks += 1

    const effectiveScore =
      typeof trace.effective.answer === 'number' ? trace.effective.answer : null
    const effectiveLabel = effectiveScore === null ? 'unanswered' : labelForScore(effectiveScore)
    effective[evaluationCase.id] = { label: effectiveLabel, score: effectiveScore }

    const candidateScore = trace.candidate?.answer
    const numericCandidate = typeof candidateScore === 'number' ? candidateScore : null
    const candidateLabel = numericCandidate === null ? null : labelForScore(numericCandidate)
    const disagreement = candidateLabel !== null && candidateLabel !== effectiveLabel
    if (candidateLabel !== null) {
      raw[evaluationCase.id] = { label: candidateLabel, score: numericCandidate }
    }
    if (disagreement) disagreements += 1

    evidenceTraces.push({
      caseId: evaluationCase.id,
      hazard: evaluationCase.hazard,
      liveSubject: evaluationCase.liveSubject,
      expected: evaluationCase.expected,
      outcome: trace.outcome,
      candidate: numericCandidate,
      confidence: trace.confidence,
      effective: effectiveLabel,
      disagreement,
      wouldApply: trace.wouldApply,
      latencyMs: trace.latencyMs,
    })

    if (paceMs > 0 && index < selected.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, paceMs))
    }
  }

  return {
    casesRun: selected.length,
    languages,
    providerCalls,
    raw: scoreEvidencePredictions(selected, raw),
    effective: scoreEvidencePredictions(selected, effective),
    traceCounts,
    evidenceTraces,
    disagreements,
    fallbacks,
    transportOrSchemaFailures: failures,
    refusals,
    malformed,
    shadowChangedRuntime: false,
  }
}

export { EVIDENCE_SET, evidenceRequest }
