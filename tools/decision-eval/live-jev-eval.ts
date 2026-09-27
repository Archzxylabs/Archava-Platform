/**
 * Explicit, server-only Jev SHADOW evaluation. Not imported by ordinary CI.
 * Example: TYPESAFE_API_KEY=... pnpm exec tsx tools/decision-eval/live-jev-eval.ts --live --max-cases 5
 *
 * Runs both harnesses on one key: the 51-utterance reference corpus (four tasks,
 * no evidence payload) and the labelled evidence set (one task, evidence
 * attached). Provider calls are reported separately and never pooled, because
 * the two sets are scored against different labels and an average over both
 * would be a number about nothing.
 */
import { JevDecisionProvider, JEV_API_KEY_ENV } from '@archava/adapters/server'
import { parseLiveOptions } from './live-options.js'
import { evaluateEvidenceShadow } from './evidence-shadow.js'
import { EVIDENCE_SET_SIZE } from './evidence-set.js'
import { formatEvidenceReport } from './evidence-metrics.js'
import { liveGateFailures } from './live-gates.js'
import { evaluateShadow } from './shadow.js'

try {
  const options = parseLiveOptions(process.argv.slice(2), process.env[JEV_API_KEY_ENV])
  const provider = new JevDecisionProvider({ apiKey: options.apiKey, timeoutMs: 4_000 })
  const result = await evaluateShadow(provider, {
    maxCases: options.maxCases,
    paceMs: options.paceMs,
    timeoutMs: 4_500,
  })
  const evidence = await evaluateEvidenceShadow(provider, {
    maxCases: options.maxCases,
    paceMs: options.paceMs,
    timeoutMs: 4_500,
  })
  process.stdout.write(
    JSON.stringify({
      mode: 'shadow',
      provider: provider.providerId,
      model: provider.model,
      casesRun: result.casesRun,
      languages: result.languages,
      providerCalls: result.providerCalls,
      tasksScored: [
        'intent_classification',
        'knowledge_routing',
        'clarification',
        'handoff_recommendation',
      ],
      evidenceSufficiency: 'unscored here by design: no evidence payload in the 51-case corpus',
      raw: result.raw,
      effective: result.effective,
      traceCounts: result.traceCounts,
      caseTraces: result.caseTraces,
      disagreements: result.disagreements,
      fallbacks: result.fallbacks,
      transportOrSchemaFailures: result.transportOrSchemaFailures,
      refusals: result.refusals,
      shadowChangedRuntime: result.shadowChangedRuntime,
    }) + '\n',
  )
  process.stdout.write(
    JSON.stringify({
      mode: 'shadow',
      task: 'evidence_sufficiency',
      provider: provider.providerId,
      model: provider.model,
      // Only the committed synthetic evidence is ever sent: no tenant page, no
      // live reservation, no mail record, and no price, availability or
      // booking-status feed for retrieval to become authority over.
      evidenceSource: 'committed synthetic excerpts',
      casesRun: evidence.casesRun,
      casesAvailable: EVIDENCE_SET_SIZE,
      languages: evidence.languages,
      providerCalls: evidence.providerCalls,
      raw: evidence.raw,
      effective: evidence.effective,
      traceCounts: evidence.traceCounts,
      evidenceTraces: evidence.evidenceTraces,
      disagreements: evidence.disagreements,
      fallbacks: evidence.fallbacks,
      transportOrSchemaFailures: evidence.transportOrSchemaFailures,
      refusals: evidence.refusals,
      malformed: evidence.malformed,
      shadowChangedRuntime: evidence.shadowChangedRuntime,
    }) + '\n',
  )
  process.stdout.write('--- evidence report ---\n' + formatEvidenceReport(evidence.raw) + '\n')
  // Every evidence miss is reported; protected live-truth misses and malformed
  // replies additionally fail the command. SHADOW still leaves turns unchanged.
  const gateFailures = liveGateFailures(result, evidence)
  if (gateFailures.length > 0) {
    process.stderr.write(`Live evaluation gate failed: ${gateFailures.join('; ')}.\n`)
    process.exitCode = 1
  }
} catch {
  process.stderr.write(
    'The external evaluation could not run. Check --live, TYPESAFE_API_KEY, and the numeric options.\n',
  )
  process.exitCode = 2
}
